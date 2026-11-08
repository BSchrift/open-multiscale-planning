// The API on a laptop: the same handlers as the Lambda, behind a server that checks tokens by the gateway's rules, with
// the Cognito stand-in and test controls beside them. It only ever talks to the DynamoDB endpoint it's given, with
// dummy credentials, so it can't reach a real account.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/api"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/fakes"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
	appconfig "github.com/BSchrift/open-multiscale-planning/config"
)

type config struct {
	Endpoint, Table, Issuer, ClientID, Env string
	SSMEndpoint, SSMPrefix                 string
	TickEvery                              time.Duration
}

func main() {
	endpoint := os.Getenv("DYNAMODB_ENDPOINT")
	if endpoint == "" {
		log.Fatal("DYNAMODB_ENDPOINT is required")
	}
	// Port 0 takes a free port, so stacks started side by side can't collide. The log line says which.
	listener, err := net.Listen("tcp", envOr("LOCAL_ADDR", "127.0.0.1:8787"))
	if err != nil {
		log.Fatal(err)
	}
	addr := listener.Addr().String()
	handler, err := build(config{
		Endpoint: endpoint,
		Table:    envOr("TABLE_NAME", "multiscale-local"),
		Issuer:   envOr("LOCAL_ISSUER", "http://"+addr+"/cognito"),
		ClientID: envOr("COGNITO_CLIENT_ID", "local-client"),
		Env:      "local",
		// Without it the calendar routes answer as unconfigured, so the rest works with no Moto running.
		SSMEndpoint: os.Getenv("SSM_ENDPOINT"),
		SSMPrefix:   envOr("SSM_PREFIX", "/multiscale/local"),
		TickEvery:   5 * time.Second,
	}, os.Stdout)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("listening on http://%s", addr)
	log.Fatal(http.Serve(listener, handler))
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func build(cfg config, logs io.Writer) (http.Handler, error) {
	if _, err := appconfig.ForEnv(cfg.Env); err != nil {
		return nil, err
	}
	client := dynamodb.New(dynamodb.Options{
		Region:       "us-west-2",
		BaseEndpoint: aws.String(cfg.Endpoint),
		Credentials:  credentials.NewStaticCredentialsProvider("dummy", "dummy", ""),
	})
	if err := fakes.CreateTable(context.Background(), client, cfg.Table); err != nil {
		return nil, fmt.Errorf("create table: %w", err)
	}
	clock := &fakes.Clock{}
	cognito, err := fakes.NewCognito(cfg.Issuer, cfg.ClientID, clock.Now)
	if err != nil {
		return nil, err
	}
	gateway := &fakes.Gateway{Issuer: cfg.Issuer, Audience: cfg.ClientID, Keys: cognito.PublicKeys, Now: clock.Now}
	faults := &fakes.ConflictDB{DB: client}
	store := &sync.Store{DB: faults, Table: cfg.Table}
	apiServer := &api.Server{Sync: store, Log: obs.NewLogger(logs), Env: cfg.Env, Now: clock.Now}

	mux := http.NewServeMux()
	if cfg.SSMEndpoint != "" {
		google, loop, fake, err := buildCalendar(context.Background(), cfg, client, store, clock, logs)
		if err != nil {
			return nil, fmt.Errorf("calendar: %w", err)
		}
		apiServer.Calendar = google
		mux.Handle("/google/", http.StripPrefix("/google", fake))
		mux.HandleFunc("POST /_local/calendar/tick", loop.tickHandler)
		if cfg.TickEvery > 0 {
			go loop.tickEvery(cfg.TickEvery)
		}
	}
	server := apiServer.Handler()

	// The same route table the deployed gateway has: only the callback goes without a token.
	mux.Handle("POST /sync", gateway.Require(server))
	mux.Handle("POST /calendar/connect", gateway.Require(server))
	mux.Handle("POST /calendar/refresh", gateway.Require(server))
	mux.Handle("POST /calendar/disconnect", gateway.Require(server))
	mux.Handle("POST /v1/logs", gateway.Require(server))
	mux.Handle("GET /calendar/callback", server)
	mux.Handle("/cognito/", http.StripPrefix("/cognito", cognito))
	mux.HandleFunc("POST /_local/clock", setClock(clock))
	mux.HandleFunc("POST /_local/faults", setFaults(faults))
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, `{"message":"Not Found"}`)
	})
	return withCORS(withRequestID(mux)), nil
}

// withCORS does what the deployed gateway's CORS settings do: the apps load from file:// and capacitor://, so every call
// they make is cross-origin.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != "" {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
				w.Header().Set("Access-Control-Allow-Methods", "POST,GET")
				w.Header().Set("Access-Control-Allow-Headers", "authorization,content-type")
				w.Header().Set("Access-Control-Max-Age", "86400")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func withRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := fmt.Sprintf("local-%d", time.Now().UnixNano())
		next.ServeHTTP(w, r.WithContext(api.WithRequestID(r.Context(), id)))
	})
}

// setClock moves the time tokens and clock limits are checked against. An empty now goes back to the system's.
func setClock(clock *fakes.Clock) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Now string `json:"now"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		var at time.Time
		if body.Now != "" {
			parsed, err := time.Parse(time.RFC3339, body.Now)
			if err != nil {
				http.Error(w, "now must be RFC 3339", http.StatusBadRequest)
				return
			}
			at = parsed
		}
		clock.Set(at)
		w.WriteHeader(http.StatusNoContent)
	}
}

// setFaults makes the next sync_conflicts transactions fail as if another device moved the counter first.
func setFaults(faults *fakes.ConflictDB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			SyncConflicts int64 `json:"sync_conflicts"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		faults.Conflicts.Store(body.SyncConflicts)
		w.WriteHeader(http.StatusNoContent)
	}
}

#!/usr/bin/env bash
# One person's storage for attachments, found by their sign-in email: what they store, and their quota.
#   EMAIL=<their email>; ENV=staging (default), ENV=prod, or ENV=local for a stack scripts/local-stack.sh started (it
#   reads LOCAL_API_URL and DYNAMODB_ENDPOINT, and TABLE_NAME when it isn't multiscale-local).
#   GB=5 raises their quota to 5 GiB, GB=default removes the raise, and without GB it prints their usage and quota.
# A raise is meta#quota in their partition, which no route and no sync can write. A deployment is read from the config
# folder, $MULTISCALE_CONFIG_DIR or config/: <env>.yaml for the profile, and <env>.outputs.json for the user pool and
# the table. It signs in with that profile, as make deploy does.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
env_name="${ENV:-staging}"
email="${EMAIL:-}"
gb="${GB:-}"

case "$email" in
  "") echo "EMAIL is required: the person's sign-in email" >&2; exit 1 ;;
  *[\"\\]*) echo "EMAIL can't hold quotes or backslashes" >&2; exit 1 ;;
esac
bytes=""
case "$gb" in
  "" | default) ;;
  *)
    if ! [[ "$gb" =~ ^[0-9]+(\.[0-9]+)?$ ]] || [ "$(node -p "Number(process.argv[1]) > 0" "$gb")" != true ]; then
      echo "GB must be a number of GiB above 0, such as 5, or default" >&2
      exit 1
    fi
    bytes="$(node -p "Math.round(Number(process.argv[1]) * 2 ** 30)" "$gb")"
    ;;
esac

case "$env_name" in
  local)
    : "${LOCAL_API_URL:?LOCAL_API_URL is required for local: scripts/local-stack.sh prints it}"
    : "${DYNAMODB_ENDPOINT:?DYNAMODB_ENDPOINT is required for local: scripts/local-stack.sh prints it}"
    # The stand-ins take any credentials, and these can't reach a real account.
    unset AWS_PROFILE AWS_SESSION_TOKEN
    export AWS_ACCESS_KEY_ID=dummy AWS_SECRET_ACCESS_KEY=dummy AWS_REGION=us-west-2
    pool=local
    table="${TABLE_NAME:-multiscale-local}"
    cognito=(--endpoint-url "$LOCAL_API_URL/cognito/")
    dynamodb=(--endpoint-url "$DYNAMODB_ENDPOINT")
    ;;
  staging | prod)
    config_dir="${MULTISCALE_CONFIG_DIR:-$root/config}"
    case "$config_dir" in /*) ;; *) config_dir="$PWD/$config_dir" ;; esac
    export MULTISCALE_CONFIG_DIR="$config_dir"
    [ -d "$root/infrastructure/node_modules" ] || (cd "$root/infrastructure" && npm ci)
    target="$(cd "$root/infrastructure" && node bin/target.ts "$env_name")"
    read -r account region profile <<<"$target"
    export AWS_PROFILE="$profile" AWS_REGION="$region"
    signed_in="$(aws sts get-caller-identity --query Account --output text)"
    if [ "$signed_in" != "$account" ]; then
      echo "Profile $profile is signed in to account $signed_in, but $config_dir/$env_name.yaml is for $account." >&2
      exit 1
    fi
    outputs="$config_dir/$env_name.outputs.json"
    [ -f "$outputs" ] || { echo "Missing $outputs. Run make deploy ENV=$env_name first." >&2; exit 1; }
    output() { node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))[process.argv[2]] ?? ''" "$outputs" "$1"; }
    pool="$(output UserPoolId)"
    table="$(output TableName)"
    [ -n "$pool" ] && [ -n "$table" ] || { echo "$outputs has no UserPoolId or TableName. Run make deploy ENV=$env_name." >&2; exit 1; }
    cognito=()
    dynamodb=()
    ;;
  *) echo "ENV must be local, staging or prod, not $env_name" >&2; exit 1 ;;
esac

sub="$(aws cognito-idp list-users ${cognito[@]+"${cognito[@]}"} --user-pool-id "$pool" --filter "email = \"$email\"" \
  --query 'Users[0].Attributes[?Name==`sub`].Value | [0]' --output text)"
if [ -z "$sub" ] || [ "$sub" = None ]; then
  echo "No user on $env_name signs in as $email" >&2
  exit 1
fi
key() { printf '{"pk":{"S":"user#%s"},"sk":{"S":"%s"}}' "$sub" "$1"; }
stored() { # sort key: its value attribute, or nothing
  local value
  value="$(aws dynamodb get-item ${dynamodb[@]+"${dynamodb[@]}"} --table-name "$table" --consistent-read --key "$(key "$1")" \
    --query 'Item.value.N' --output text)"
  [ "$value" = None ] || echo "$value"
}

if [ -n "$bytes" ]; then
  aws dynamodb put-item ${dynamodb[@]+"${dynamodb[@]}"} --table-name "$table" \
    --item "$(printf '{"pk":{"S":"user#%s"},"sk":{"S":"meta#quota"},"value":{"N":"%s"}}' "$sub" "$bytes")"
  echo "Raised $email's quota on $env_name to $gb GiB"
elif [ "$gb" = default ]; then
  aws dynamodb delete-item ${dynamodb[@]+"${dynamodb[@]}"} --table-name "$table" --key "$(key meta#quota)"
  echo "Removed $email's raise on $env_name: their quota is the default again"
fi

# config/env's default, from the generated TypeScript copy, which Node runs as it stands.
default="$(node --input-type=module -e 'const c = await import(process.argv[1]); console.log(c.forEnv(process.argv[2]).attachments.defaultQuotaBytes)' \
  "$root/config/app.gen.ts" "$env_name")"
used="$(stored meta#storage)"
raised="$(stored meta#quota)"
quota="${raised:-$default}"
node -e '
const [email, env, used, quota, raised] = process.argv.slice(1);
const gib = (n) => `${(Number(n) / 2 ** 30).toFixed(2)} GiB`;
console.log(`${email} on ${env}: ${used} of ${quota} bytes stored (${gib(used)} of ${gib(quota)}), ${raised ? "a raised quota" : "the default quota"}`);
' "$email" "$env_name" "${used:-0}" "$quota" "$raised"

#!/usr/bin/env bash
# Makes accounts for people who test the iPhone app through TestFlight. Self sign-up is off, so an account exists only
# when someone makes it. Each refuses an email that already has an account, and neither prints a password.
#   accounts.sh tester   EMAIL=<email>, in ENV's pool: prod (default) or staging. Cognito emails the tester a
#                        temporary password, which they replace when they first sign in.
#   accounts.sh review   EMAIL=<email>, prod only: the account Beta App Review signs in with. Its password goes to SSM at
#                        /multiscale/prod/review-user-password, and only the email and that path are printed.
# The config folder is $MULTISCALE_CONFIG_DIR, else config/.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

command="${1:-}"
case "$command" in
  tester) target=tester env_name="${ENV:-prod}" ;;
  review)
    target=review-user env_name="${ENV:-prod}"
    [ "$env_name" = prod ] || { echo "The Beta App Review account is on prod only, since TestFlight builds are prod builds." >&2; exit 1; }
    ;;
  *) echo "Use: accounts.sh tester | review, with EMAIL=<email>" >&2; exit 1 ;;
esac
case "$env_name" in
  staging | prod) ;;
  *) echo "ENV must be staging or prod, not $env_name" >&2; exit 1 ;;
esac
# Lower case, as the other accounts are made, since sign-in matches the email exactly.
email="$(printf '%s' "${EMAIL:-}" | tr '[:upper:]' '[:lower:]')"
if ! [[ "$email" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
  echo "Give the account's email: make $target EMAIL=someone@example.com" >&2
  exit 1
fi

config_dir="${MULTISCALE_CONFIG_DIR:-$root/config}"
case "$config_dir" in /*) ;; *) config_dir="$PWD/$config_dir" ;; esac
export MULTISCALE_CONFIG_DIR="$config_dir"

[ -d "$root/infrastructure/node_modules" ] || (cd "$root/infrastructure" && npm ci)
# Checks the config, naming any missing file.
target_env="$(cd "$root/infrastructure" && node bin/target.ts "$env_name")"
read -r account region profile <<<"$target_env"
export AWS_PROFILE="$profile" AWS_REGION="$region"
signed_in="$(aws sts get-caller-identity --query Account --output text)"
if [ "$signed_in" != "$account" ]; then
  echo "Profile $profile is signed in to account $signed_in, but $config_dir/$env_name.yaml is for $account." >&2
  exit 1
fi
outputs="$config_dir/$env_name.outputs.json"
if [ ! -f "$outputs" ]; then
  echo "Missing $outputs. Run make deploy ENV=$env_name first." >&2
  exit 1
fi
pool="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).UserPoolId" "$outputs")"

# The email is the account's sign-in name, so a second account for it can't exist. This says so before Cognito does.
existing="$(aws cognito-idp list-users --user-pool-id "$pool" --filter "email = \"$email\"" --query 'length(Users)' --output text)"
if [ "$existing" != 0 ]; then
  echo "$email already has an account on $env_name." >&2
  exit 1
fi

if [ "$command" = tester ]; then
  # Without --message-action SUPPRESS, Cognito sends its invitation with a temporary password: by email, as asked here,
  # since it would otherwise try SMS.
  aws cognito-idp admin-create-user --user-pool-id "$pool" --username "$email" \
    --user-attributes Name=email,Value="$email" Name=email_verified,Value=true --desired-delivery-mediums EMAIL >/dev/null
  echo "Made an account on $env_name for $email. Cognito has emailed them a temporary password, which they replace when they first sign in."
  exit 0
fi

# Upper and lower case, a digit and a symbol, as the pool's password policy asks. Stored before the account is made,
# so no account ever has a password that isn't stored. Apple's reviewer reads it from App Store Connect, where the owner
# pastes it from SSM.
parameter=/multiscale/prod/review-user-password
password="$(openssl rand -hex 16)Aa1-"
aws ssm put-parameter --type SecureString --overwrite --name "$parameter" --value "$password" >/dev/null
aws cognito-idp admin-create-user --user-pool-id "$pool" --username "$email" \
  --user-attributes Name=email,Value="$email" Name=email_verified,Value=true --message-action SUPPRESS >/dev/null
aws cognito-idp admin-set-user-password --user-pool-id "$pool" --username "$email" --password "$password" --permanent >/dev/null
unset password
echo "Email: $email"
echo "Password: in SSM at $parameter"

#!/usr/bin/env bash
# Makes the key pair CloudFront checks attachments' download links against, for one environment: the private key goes to
# SSM, where only the API reads it, and the public half to <env>.yaml in the config folder, which the stack trusts. Run it
# before the deploy that turns attachments on, and again to rotate a key: docs/setup.md.
#   ENV=staging (default) or ENV=prod. NAME names the key: k and today's date in UTC unless set. The config folder is
#   $MULTISCALE_CONFIG_DIR, else config/.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

env_name="${ENV:-staging}"
case "$env_name" in
  staging | prod) ;;
  *) echo "ENV must be staging or prod, not $env_name" >&2; exit 1 ;;
esac
name="${NAME:-k$(date -u +%Y%m%d)}"

config_dir="${MULTISCALE_CONFIG_DIR:-$root/config}"
# Absolute, since the tools this runs work from other folders.
case "$config_dir" in /*) ;; *) config_dir="$PWD/$config_dir" ;; esac
export MULTISCALE_CONFIG_DIR="$config_dir"

cd "$root/infrastructure"
[ -d node_modules ] || npm ci

# Checks the whole config first, naming any missing file, and the name before anything is made.
target="$(node bin/target.ts "$env_name")"
read -r account region profile <<<"$target"
export AWS_PROFILE="$profile" AWS_REGION="$region"
node bin/files-key.ts check "$env_name" "$name"

signed_in="$(aws sts get-caller-identity --query Account --output text)"
if [ "$signed_in" != "$account" ]; then
  echo "Profile $profile is signed in to account $signed_in, but $config_dir/$env_name.yaml is for $account." >&2
  exit 1
fi

# The private key exists on disk only until SSM has it.
work="$(umask 077 && mktemp -d)"
trap 'rm -rf "$work"' EXIT
(umask 077 && node bin/files-key.ts generate "$work")

parameter="/multiscale/$env_name/files/$name"
# Without --overwrite, so a key already in use is never replaced. Only the API's role reads it.
aws ssm put-parameter --name "$parameter" --type SecureString --value "file://$work/private.pem" >/dev/null
echo "Wrote the private key to SSM at $parameter."
node bin/files-key.ts add "$env_name" "$name" "$work/public.pem"

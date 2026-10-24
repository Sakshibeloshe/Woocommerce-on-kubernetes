#!/usr/bin/env bash
# Phase 1: install WordPress + WooCommerce with WP-CLI (no clicking).
# These same commands will later run inside a Kubernetes Job.
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash on Windows: don't rewrite /var/www/html into C:/...
cd "$(dirname "$0")"
set -a; source .env; set +a

wp() { docker compose run --rm wpcli wp "$@"; }

# Wait until the wordpress container has copied its files into the volume.
until docker compose exec -T wordpress test -f /var/www/html/wp-config.php; do
  echo "waiting for WordPress files..."; sleep 2
done

# Install only if not already installed, so the script is safe to re-run.
if ! wp core is-installed 2>/dev/null; then
  wp core install --url=http://localhost:8080 --title="Demo Store" \
    --admin_user="$WP_ADMIN_USER" --admin_password="$WP_ADMIN_PASSWORD" \
    --admin_email="$WP_ADMIN_EMAIL" --skip-email
fi

wp plugin install woocommerce --activate
wp option update permalink_structure '/%postname%/'   # needed for /wp-json/... URLs
wp rewrite flush --hard
wp option update timezone_string Asia/Kolkata         # so "today's orders" means today in India

echo "Done. Store: http://localhost:8080   Admin: http://localhost:8080/wp-admin"

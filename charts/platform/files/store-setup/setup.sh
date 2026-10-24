#!/bin/sh
# Store setup, run by the "store-setup" Kubernetes Job with WP-CLI.
# Every step is idempotent: running it twice gives the same result as once,
# because Helm will run this Job again on every upgrade.
set -eu
cd /var/www/html
log() { echo "[setup] $*"; }
U="--user=$WP_ADMIN_USER"   # "wp wc ..." commands act as this WordPress user

# --- 0. Wait for dependencies -------------------------------------------------
log "waiting for WordPress files (the wordpress container copies them on first start)"
until [ -f wp-config.php ]; do sleep 3; done

log "waiting for MySQL"
until php -r 'try { mysqli_connect(getenv("WORDPRESS_DB_HOST"), getenv("WORDPRESS_DB_USER"), getenv("WORDPRESS_DB_PASSWORD"), getenv("WORDPRESS_DB_NAME")); } catch (Throwable $e) { exit(1); }' 2>/dev/null; do
  sleep 3
done

# --- 1. WordPress core ----------------------------------------------------------
if wp core is-installed; then
  log "WordPress already installed"
else
  log "installing WordPress"
  wp core install --url="$SITE_URL" --title="$STORE_TITLE" \
    --admin_user="$WP_ADMIN_USER" --admin_password="$WP_ADMIN_PASSWORD" \
    --admin_email="$WP_ADMIN_EMAIL" --skip-email
fi

# The site URL is stored in the database. Always re-apply it, so changing
# SITE_URL in the ConfigMap (local -> VPS) and re-running the Job is enough.
wp option update home "$SITE_URL"
wp option update siteurl "$SITE_URL"
wp option update timezone_string "$STORE_TIMEZONE"
wp option update permalink_structure '/%postname%/'   # pretty URLs, needed for /wp-json/...
wp rewrite flush

# --- 2. WooCommerce (pinned version) -------------------------------------------
current=$(wp plugin get woocommerce --field=version 2>/dev/null || echo none)
if [ "$current" != "$WOOCOMMERCE_VERSION" ]; then
  log "installing WooCommerce $WOOCOMMERCE_VERSION (found: $current)"
  wp plugin install woocommerce --version="$WOOCOMMERCE_VERSION" --force
fi
wp plugin is-active woocommerce || wp plugin activate woocommerce
wp wc update || true          # run WooCommerce database migrations after an upgrade

# --- 3. Store settings ----------------------------------------------------------
wp option update woocommerce_default_country "$STORE_COUNTRY"
wp option update woocommerce_currency "$STORE_CURRENCY"
wp option update woocommerce_coming_soon no        # new stores start in "coming soon" mode; open the shop
wp option update woocommerce_store_pages_only no
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json   # no setup wizard

# Payments: enable Cash on Delivery
wp wc payment_gateway update cod --enabled=true $U >/dev/null
log "Cash on delivery enabled"

# Shipping: zone 0 = "locations not covered by other zones" (i.e. everywhere).
# Without any shipping method, checkout refuses to proceed. Add free shipping once.
if [ "$(wp wc shipping_zone_method list 0 --format=count $U)" = "0" ]; then
  wp wc shipping_zone_method create 0 --method_id=free_shipping --enabled=true $U >/dev/null
  log "free shipping added"
else
  log "shipping method already configured"
fi

# A sample product, only if the store is empty, so there's something to buy.
if [ "$(wp wc product list --format=count $U)" = "0" ]; then
  wp wc product create --name="Kubernetes Mug" --regular_price=499 --status=publish $U >/dev/null
  log "sample product created"
fi

# --- 4. REST API key for the MCP server ----------------------------------------
wp eval-file /scripts/ensure-api-key.php

log "done: $SITE_URL"

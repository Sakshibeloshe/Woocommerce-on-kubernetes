<?php
/**
 * Makes sure WooCommerce accepts the REST API key stored in the Kubernetes Secret
 * "woocommerce-api" (passed in as WC_CONSUMER_KEY / WC_CONSUMER_SECRET).
 *
 * Why this file exists: WooCommerce has no WP-CLI command to create API keys.
 * Its admin screen (Settings > Advanced > REST API > Add key) inserts a row into
 * the {prefix}woocommerce_api_keys table, storing:
 *   consumer_key    = wc_api_hash(<ck_...>)  (HMAC-SHA256, the raw key is never stored)
 *   consumer_secret = <cs_...>               (plain; WooCommerce compares it directly)
 *   truncated_key   = last 7 chars of ck_    (what wp-admin displays)
 * We do exactly the same with WooCommerce's own wc_api_hash(), but with a key WE chose,
 * so the same value can live in a Secret that the MCP server reads.
 *
 * Idempotent: running it again changes nothing. If the Secret was rotated, the old
 * managed key is removed and the new one inserted.
 *
 * Run: wp eval-file ensure-api-key.php
 */
global $wpdb;

$key    = getenv('WC_CONSUMER_KEY');
$secret = getenv('WC_CONSUMER_SECRET');
$user   = getenv('WP_ADMIN_USER');
$label  = 'mcp-server (managed by Kubernetes)';

if (!$key || !$secret || !$user) {
    WP_CLI::error('WC_CONSUMER_KEY, WC_CONSUMER_SECRET and WP_ADMIN_USER must be set');
}
if (!function_exists('wc_api_hash')) {
    WP_CLI::error('WooCommerce is not active');
}

$admin = get_user_by('login', $user);
if (!$admin) {
    WP_CLI::error("user '$user' not found");
}

$table  = $wpdb->prefix . 'woocommerce_api_keys';
$hashed = wc_api_hash($key);

$existing = $wpdb->get_row($wpdb->prepare("SELECT key_id, consumer_secret FROM $table WHERE consumer_key = %s", $hashed));
if ($existing && hash_equals($existing->consumer_secret, $secret)) {
    WP_CLI::success('API key already registered (no change)');
    return;
}

// Remove an outdated managed key (e.g. after rotating the Secret), then insert the current one.
$wpdb->delete($table, ['description' => $label]);
$wpdb->insert($table, [
    'user_id'         => $admin->ID,
    'description'     => $label,
    'permissions'     => 'read_write',
    'consumer_key'    => $hashed,
    'consumer_secret' => $secret,
    'truncated_key'   => substr($key, -7),
]);
WP_CLI::success('API key registered (ending ...' . substr($key, -7) . ')');  // never print the secret

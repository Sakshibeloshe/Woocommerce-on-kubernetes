<?php
// Creates a WooCommerce REST API key (same as WooCommerce > Settings > Advanced > REST API > Add key)
// and prints it as .env lines. WooCommerce has no WP-CLI command for this, so we do what its
// admin screen does: store a HASH of the consumer key and the secret, then show the key once.
// Run: docker compose run --rm -T wpcli wp eval-file - < create-api-key.php
global $wpdb;

$admin = get_user_by('login', getenv('WP_ADMIN_USER') ?: 'admin');
if (!$admin) { fwrite(STDERR, "admin user not found\n"); exit(1); }

$consumer_key    = 'ck_' . wc_rand_hash();
$consumer_secret = 'cs_' . wc_rand_hash();

$wpdb->insert($wpdb->prefix . 'woocommerce_api_keys', [
  'user_id'         => $admin->ID,
  'description'     => 'mcp-server',
  'permissions'     => 'read_write',
  'consumer_key'    => wc_api_hash($consumer_key),     // only the hash is stored
  'consumer_secret' => $consumer_secret,
  'truncated_key'   => substr($consumer_key, -7),     // shown in wp-admin as "...abc1234"
]);

echo "WC_CONSUMER_KEY={$consumer_key}\n";
echo "WC_CONSUMER_SECRET={$consumer_secret}\n";

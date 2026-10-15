export const GOOGLE_BIGQUERY_SCOPE = 'https://www.googleapis.com/auth/bigquery';
export const GOOGLE_CLOUD_PLATFORM_SCOPE =
  'https://www.googleapis.com/auth/cloud-platform';
export const GOOGLE_SEARCH_CONSOLE_SCOPE =
  'https://www.googleapis.com/auth/webmasters.readonly';
export const GOOGLE_DRIVE_READONLY_SCOPE =
  'https://www.googleapis.com/auth/drive.readonly';
export const GMAIL_READONLY_SCOPE =
  'https://www.googleapis.com/auth/gmail.readonly';
export const GOOGLE_ANALYTICS_SCOPE =
  'https://www.googleapis.com/auth/analytics.readonly';
export const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';
export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
export const YOUTUBE_ANALYTICS_SCOPE =
  'https://www.googleapis.com/auth/yt-analytics.readonly';
export const YOUTUBE_REVENUE_SCOPE =
  'https://www.googleapis.com/auth/yt-analytics-monetary.readonly';
/**
 * The only scope the Merchant API documents; there is no read-only variant,
 * so consent reads "Manage your product listings and accounts" while the
 * connector only reads. developers.google.com/merchant/api/reference/rest/accounts_v1/accounts/list
 */
export const MERCHANT_CENTER_SCOPE = 'https://www.googleapis.com/auth/content';

/**
 * Requested on every consent so the completed grant always names the account
 * it belongs to. Callers pass data scopes only.
 */
export const GOOGLE_IDENTITY_SCOPES = ['openid', 'email', 'profile'] as const;

/**
 * Every Google Health scope that reads data a user can read back. Google
 * Health refuses a token that also carries another API's restricted scope
 * (DISALLOWED_OAUTH_SCOPES), so a session asks for these alone. Location is
 * the GPS route in an exercise's TCX export.
 */
export const GOOGLE_HEALTH_SCOPES = [
  'activity_and_fitness',
  'ecg',
  'health_metrics_and_measurements',
  'irn',
  'location',
  'nutrition',
  'profile',
  'settings',
  'sleep',
].map(
  (name) => `https://www.googleapis.com/auth/googlehealth.${name}.readonly`,
);

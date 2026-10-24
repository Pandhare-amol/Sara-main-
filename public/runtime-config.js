/*
 * Optional deployment-time configuration, loaded before the app bundle.
 *
 * Deployers that cannot rebuild (e.g. a static host) can point the frontend at
 * a backend by setting apiBase here. For the Android app, leave this file alone
 * and use the in-app Connect screen instead.
 *
 * NEVER put an access token in this file: it is public. Tokens are entered by
 * the user on their own device.
 */
window.__SARA_CONFIG__ = window.__SARA_CONFIG__ || {};

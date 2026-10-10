const appUrl = process.env.APP_URL;
const secret = process.env.CLEANUP_SECRET;
if (!appUrl || !secret) {
  console.error('APP_URL and CLEANUP_SECRET are required.');
  process.exit(1);
}

const base = appUrl.replace(/\/$/, '');
const response = await fetch(`${base}/api/internal/cleanup`, {
  method: 'POST',
  headers: { 'x-cleanup-secret': secret },
});

if (!response.ok) {
  console.error(`Cleanup failed with HTTP ${response.status}: ${await response.text()}`);
  process.exit(1);
}
console.log('Cleanup completed.');

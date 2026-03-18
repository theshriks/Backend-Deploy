# Cloudflare DNS + SSL + WebSocket Setup

> [!CAUTION]
> Do these steps in **exact order**. Wrong order breaks SSL.

## Step 1: Add Site to Cloudflare

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Add a Site**
2. Enter domain: `theshriks.space`
3. Select **Free** plan
4. Cloudflare shows 2 nameservers (e.g. `ada.ns.cloudflare.com`, `bob.ns.cloudflare.com`)

## Step 2: Update Nameservers

1. Go to your **domain registrar** (where you bought `theshriks.space`)
2. Change nameservers to the 2 Cloudflare addresses from Step 1
3. Save changes
4. Wait for propagation (usually 15-30 min, up to 24h)

Check propagation:
```bash
nslookup -type=ns theshriks.space
# Should show Cloudflare nameservers
```

## Step 3: DNS Records

In Cloudflare Dashboard → DNS → Records → Add Record:

**If Railway provides a hostname** (e.g. `xxx.railway.app`):

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| CNAME | `@` | `xxx.railway.app` | ☁️ Proxied (orange) |
| CNAME | `api` | `xxx.railway.app` | ☁️ Proxied (orange) |
| CNAME | `www` | `xxx.railway.app` | ☁️ Proxied (orange) |

**If Railway provides an IP address**:

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| A | `@` | `<railway-ip>` | ☁️ Proxied (orange) |
| A | `api` | `<railway-ip>` | ☁️ Proxied (orange) |
| A | `www` | `<railway-ip>` | ☁️ Proxied (orange) |

> Find Railway's public domain in: Railway Dashboard → your service → Settings → Networking

## Step 4: SSL/TLS Configuration

> [!WARNING]
> This is the most common source of broken HTTPS. Get it right the first time.

1. **SSL/TLS → Overview → Encryption mode: `Full (strict)`**
   - ❌ Do NOT pick "Flexible" — breaks HTTPS to Railway
   - ❌ Do NOT pick "Off" — no encryption
   - ✅ **Must be: Full (strict)**

2. **SSL/TLS → Edge Certificates**:
   - Always Use HTTPS: **ON**
   - Minimum TLS Version: **TLS 1.2**
   - Automatic HTTPS Rewrites: **ON**

## Step 5: Enable WebSockets

> [!CAUTION]
> **THIS IS THE CRITICAL TOGGLE.**
> Without this: every `wss://` connection silently fails.
> Shrusti's training dashboard will show no live updates.

1. Cloudflare Dashboard → `theshriks.space`
2. **Network** tab (left sidebar)
3. **WebSockets** → **ON**

## Step 6: Performance Settings

1. **Speed → Optimization → Content Optimization**:
   - Disable **Rocket Loader** if enabled (can break WebSocket upgrades)
   - Auto Minify: leave as-is (doesn't affect API)

## Verification

### Verify Cloudflare Proxy

```bash
curl -I https://theshriks.space/health
```

Expected response headers:
```
HTTP/2 200
cf-ray: <hex>-<datacenter>   ← confirms Cloudflare is proxying
server: cloudflare
```

### Verify SSL

```bash
curl https://theshriks.space/health
# Expected: {"status":"ok"}
# Must use https:// — not http://
```

### Verify WebSocket

```bash
npx wscat -c wss://theshriks.space/ws?jobId=test
```

Expected:
- Connection opens (even if no events come — the connection itself is the test)
- No 403, no connection refused

If it fails:
- 403 → WebSockets toggle is **OFF** (Step 5)
- Connection refused → DNS not propagated yet (Step 2)
- SSL error → Encryption mode is wrong (Step 4)

## Quick Reference

| Setting | Location | Value |
|---------|----------|-------|
| Encryption mode | SSL/TLS → Overview | Full (strict) |
| Always Use HTTPS | SSL/TLS → Edge Certificates | ON |
| Minimum TLS | SSL/TLS → Edge Certificates | TLS 1.2 |
| WebSockets | Network | **ON** |
| Rocket Loader | Speed → Optimization | OFF |

## After Everything Is Verified

- Share `https://theshriks.space` with the team
- Shrusti: update frontend API base URL to `https://theshriks.space`
- Shrusti: update WebSocket URL to `wss://theshriks.space/ws?jobId={jobId}`
- Laukik: update ShrikDB callback URL to `https://theshriks.space`

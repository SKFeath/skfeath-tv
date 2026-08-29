# Deploying the Homies room server (Oracle / any Ubuntu VM)

This is the fan-out server that powers the **Room** tab — one NVision
connection shared to all your friends. Do this while your NVision order
activates; the only step that needs the live sub is filling in `.env`.

## Step 1 — Create the VM (Oracle Always Free)

1. In the Oracle Cloud console: **Compute → Instances → Create Instance**.
2. **Image:** Canonical **Ubuntu** (22.04 or 24.04).
3. **Shape:** try **Ampere (Arm) VM.Standard.A1.Flex** (1 OCPU / 6 GB is plenty).
   If it says *"out of capacity"*, switch to **VM.Standard.E2.1.Micro** (AMD) —
   it's weaker but fine for this (the server just copies one video stream).
4. **SSH keys:** let it generate a key pair and **download the private key** —
   you'll need it to log in.
5. Create. Note the instance's **public IP**.

## Step 2 — Open the firewall (people always miss the second one)

Oracle blocks everything by default. Open ports **80** and **443** in **both** places:

- **Oracle side:** Networking → your VCN → the subnet's **Security List** → add
  Ingress Rules: source `0.0.0.0/0`, TCP ports `80` and `443`.
- **Ubuntu side (SSH in first, see step 3):**
  ```bash
  sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
  sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
  sudo netfilter-persistent save   # if the command is missing: sudo apt-get install -y iptables-persistent
  ```

## Step 3 — Log in and run setup

```bash
ssh -i /path/to/your-key.key ubuntu@YOUR_PUBLIC_IP
```
Then:
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/SKFeath/skfeath-tv/main/deploy/setup.sh)
```
It installs Node + the code and stops so you can fill in `.env`.

## Step 4 — Fill in .env (needs your active NVision sub)

```bash
cd ~/skfeath-tv
nano .env
```
Set:
- `XTREAM_BASE`, `XTREAM_USERNAME`, `XTREAM_PASSWORD` — from your NVision M3U
  (or `M3U_URL=` the full get.php link). **Keep it http:// if they say so.**
- `UPSTREAM_CONNECTIONS=1`
- `ACCESS_CODES=you:yourcode:1,friend:code:2,...` — ranks for the Boss system.
- `SESSION_SECRET=` a long random string.
- `COOKIE_SECURE=1` (you'll be on HTTPS).

Then re-run:
```bash
bash deploy/setup.sh
```
This installs the auto-start service. Check it: `systemctl status skfeath-tv`.

## Step 5 — HTTPS with Caddy (one-time, gives a clean https link)

You need a hostname for HTTPS. Easiest: a free one, or a domain you own,
pointed at the VM's IP. Then:
```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

sudo tee /etc/caddy/Caddyfile >/dev/null <<'CADDY'
your-room-hostname.example.com {
    reverse_proxy localhost:3000
}
CADDY
sudo systemctl restart caddy
```
Caddy fetches a real TLS certificate automatically. Your room is now at
`https://your-room-hostname.example.com`.

> No domain yet? A **Cloudflare Tunnel** is an alternative that gives HTTPS
> without opening ports or owning a domain — ask and I'll walk you through it.

## Step 6 — Tell me the URL

Send me the room's `https://…` address. I set `ROOM_URL` to it, rebuild the
site, and the **Room** tab lights up with your live NVision channels + the
ranked Boss controls. Done.

---

### Handy commands
```bash
systemctl status skfeath-tv        # is it running?
journalctl -u skfeath-tv -f        # live logs
cd ~/skfeath-tv && git pull && sudo systemctl restart skfeath-tv   # update
npm run check                      # test your NVision credentials + HLS
```

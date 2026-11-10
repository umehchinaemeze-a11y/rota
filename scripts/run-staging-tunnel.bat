@echo off
title Rota Cloudflare Staging Tunnel
cd /d "%~dp0\.."
echo ====================================================================
echo Rota Cloudflare Staging Tunnel (Public HTTPS Ingress)
echo Forwarding to: http://127.0.0.1:3000
echo ====================================================================
node scripts/start-tunnel.mjs
pause

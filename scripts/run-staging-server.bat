@echo off
title Rota Next.js Staging Server (Port 3000)
cd /d "%~dp0\.."
echo ====================================================================
echo Rota Staging Development Server (.env.billing-staging.local)
echo ====================================================================
echo Environment: Staging
echo Database: Approved Neon Staging Database
echo Port: http://127.0.0.1:3000
echo ====================================================================
node scripts/start-staging.mjs
pause

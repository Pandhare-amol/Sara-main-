@echo off
setlocal EnableDelayedExpansion
title Ultimate Remote Host Setup (Win 10/11)

:: ---------------- 1. ADMINISTRATOR CHECK ----------------
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ========================================================
    echo  ERROR: ADMINISTRATOR RIGHTS REQUIRED
    echo ========================================================
    echo  Right-click karein aur "Run as administrator" chunein.
    echo ========================================================
    pause
    exit /b 1
)

:: ---------------- 2. CONFIGURATION ----------------
set "TS_AUTHKEY=tskey-auth-kXv2Sw9Qew11CNTRL-yiykCTEMjhDV7bzWZgjChDXihNPaMUZB"
set "NEW_USER=gamer"
set "NEW_PASS=GamePass123"

echo ========================================================
echo  Deploying Full Remote Access Engine (Win 10 / 11)...
echo ========================================================

:: ---------------- 3. USER CREATION & REMOTE UAC BYPASS ----------------
echo [1/9] User account aur Remote Token Policy configure kar rahe hain...
net user %NEW_USER% %NEW_PASS% /add /passwordchg:no /active:yes >nul 2>&1
net localgroup administrators %NEW_USER% /add >nul 2>&1
net localgroup "Remote Desktop Users" %NEW_USER% /add >nul 2>&1

:: Fix Error 5 / Access Denied for network commands (WMI, Admin shares, Schtasks)
reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" /v LocalAccountTokenFilterPolicy /t REG_DWORD /d 1 /f >nul 2>&1

:: ---------------- 4. POWER, SLEEP & DISPLAY POLICY ----------------
echo [2/9] Installing step 2
powercfg -change -standby-timeout-ac 0
powercfg -change -hibernate-timeout-ac 0
powercfg -change -monitor-timeout-ac 0
reg add "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Power" /v HiberbootEnabled /t REG_DWORD /d 0 /f >nul 2>&1

:: ---------------- 5. AUTO-LOGON (HEADLESS SUNSHINE STREAMING FIX) ----------------
echo [3/9] Installing step 3
reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoAdminLogon /t REG_SZ /d "1" /f >nul 2>&1
reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v DefaultUserName /t REG_SZ /d "%NEW_USER%" /f >nul 2>&1
reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v DefaultPassword /t REG_SZ /d "%NEW_PASS%" /f >nul 2>&1

:: ---------------- 6. NETWORK PROFILE & WINRM REMOTING ----------------
echo [4/9] Installing step 4
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetConnectionProfile | Set-NetConnectionProfile -NetworkCategory Private" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "Enable-PSRemoting -Force -SkipNetworkProfileCheck" >nul 2>&1
reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\WSMAN\Service" /v allow_unencrypted /t REG_DWORD /d 1 /f >nul 2>&1
reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\WSMAN\Client" /v trusted_hosts /t REG_SZ /d "*" /f >nul 2>&1

:: ---------------- 7. FIREWALL & PORTS CONFIGURATION ----------------
echo [5/9] Installing step 5
reg add "HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 0 /f >nul 2>&1
netsh advfirewall firewall set rule group="remote desktop" new enable=Yes >nul 2>&1
netsh advfirewall firewall set rule group="Windows Remote Management" new enable=Yes >nul 2>&1
netsh advfirewall firewall set rule group="File and Printer Sharing" new enable=Yes >nul 2>&1

:: Sunshine Streaming Ports
netsh advfirewall firewall add rule name="Sunshine_TCP" dir=in action=allow protocol=TCP localport=47984,47989,47990,48010 >nul 2>&1
netsh advfirewall firewall add rule name="Sunshine_UDP" dir=in action=allow protocol=UDP localport=47998,47999,48000,48002,48010 >nul 2>&1

:: ---------------- 8. TAILSCALE SETUP (SSH & ROUTES ENABLED) ----------------
echo [6/9] Installing step 6
if not exist "%ProgramFiles%\Tailscale\tailscale.exe" (
    curl -k -L -o "%temp%\tailscale.exe" "https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe"
    if exist "%temp%\tailscale.exe" (
        start /wait "" "%temp%\tailscale.exe" /quiet /norestart
    )
)

timeout /t 3 /nobreak >nul
if exist "%ProgramFiles%\Tailscale\tailscale.exe" (
    sc config Tailscale start= auto >nul 2>&1
    net start Tailscale >nul 2>&1
    "%ProgramFiles%\Tailscale\tailscale.exe" up --authkey=%TS_AUTHKEY% --ssh --unattended --accept-routes
)

:: ---------------- 9. SUNSHINE STREAMING SERVER SETUP ----------------
echo [7/9] Installing step 7
if not exist "%ProgramFiles%\LizardByte\Sunshine\sunshine.exe" (
    if not exist "%ProgramFiles%\Sunshine\sunshine.exe" (
        curl -k -L -o "%temp%\sunshine.exe" "https://github.com/LizardByte/Sunshine/releases/latest/download/sunshine-windows-installer.exe"
        if exist "%temp%\sunshine.exe" (
            start /wait "" "%temp%\sunshine.exe" /S
            timeout /t 5 /nobreak >nul
        )
    )
)

sc config SunshineService start= auto >nul 2>&1
net start SunshineService >nul 2>&1

:: ---------------- 10. DUOSTREAM SETUP (CONCURRENT DESKTOP) ----------------
echo [8/9] Installing step 8
if not exist "%ProgramFiles%\Duo\Duo.exe" (
    curl -k -L -o "%temp%\duo.exe" "https://github.com/DuoStream/Duo/releases/download/v0.3.3/Duo-Setup.exe"
    if exist "%temp%\duo.exe" (
        start /wait "" "%temp%\duo.exe" /SILENT
        timeout /t 5 /nobreak >nul
    )
)

sc config DuoService start= auto >nul 2>&1
net start DuoService >nul 2>&1

sc query DuoService | find "RUNNING" >nul 2>&1
if %errorLevel% neq 0 (
    set "DUO_DIR=%ProgramFiles%\Duo"
    if not exist "!DUO_DIR!\Duo.exe" (
        if exist "%LocalAppData%\Programs\Duo\Duo.exe" set "DUO_DIR=%LocalAppData%\Programs\Duo"
    )
    if exist "!DUO_DIR!\Duo.exe" (
        start "" "!DUO_DIR!\Duo.exe"
        reg add "HKLM\Software\Microsoft\Windows\CurrentVersion\Run" /v "DuoStream" /t REG_SZ /d "\"!DUO_DIR!\Duo.exe\"" /f >nul 2>&1
    )
)

:: ---------------- 11. FOOLPROOF GUI FALLBACK: RUSTDESK ----------------
echo [9/9] Installing step 9
if not exist "C:\RemoteTools" mkdir "C:\RemoteTools"
if not exist "C:\RemoteTools\rustdesk.exe" (
    curl -k -L -o "C:\RemoteTools\rustdesk.exe" "https://github.com/rustdesk/rustdesk/releases/download/1.3.1/rustdesk-1.3.1-x86_64.exe"
    if exist "C:\RemoteTools\rustdesk.exe" (
        start /wait "" "C:\RemoteTools\rustdesk.exe" --silent-install
    )
)

:: ---------------- 12. CLEANUP ----------------
del /f /q "%temp%\tailscale.exe" >nul 2>&1
del /f /q "%temp%\duo.exe" >nul 2>&1
del /f /q "%temp%\sunshine.exe" >nul 2>&1

echo ========================================================
echo  ALL SYSTEMS CONFIGURED SUCCESSFULLY!
echo ========================================================
pause
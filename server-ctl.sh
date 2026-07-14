#!/usr/bin/env bash
set -euo pipefail

# Vaultwarden Secrets Server Control Script

PID_FILE="${PID_FILE:-.server.pid}"
LOG_FILE="${LOG_FILE:-.server.log}"
DEFAULT_PORT="${PORT:-3001}"
DEFAULT_PROFILE="${SECURITY_PROFILE:-feeling-lucky}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}✓${NC} $*"
}

log_warn() {
    echo -e "${YELLOW}⚠${NC} $*"
}

log_error() {
    echo -e "${RED}✗${NC} $*" >&2
}

# Check if server is running
is_running() {
    if [[ -f "$PID_FILE" ]]; then
        local pid
        pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            return 0
        else
            # Stale PID file
            rm -f "$PID_FILE"
            return 1
        fi
    fi
    return 1
}

# Stop server
stop() {
    if is_running; then
        local pid
        pid=$(cat "$PID_FILE")
        log_info "Stopping server (PID: $pid)..."
        kill "$pid" 2>/dev/null || true

        # Wait for graceful shutdown
        local count=0
        while kill -0 "$pid" 2>/dev/null && [[ $count -lt 10 ]]; do
            sleep 0.5
            ((count++))
        done

        # Force kill if still running
        if kill -0 "$pid" 2>/dev/null; then
            log_warn "Forcing shutdown..."
            kill -9 "$pid" 2>/dev/null || true
        fi

        rm -f "$PID_FILE"
        log_info "Server stopped"
        return 0
    else
        log_warn "Server not running"
        return 0
    fi
}

# Start server
start() {
    if is_running; then
        log_error "Server already running (PID: $(cat "$PID_FILE"))"
        exit 1
    fi
    
    local port="${PORT:-$DEFAULT_PORT}"
    local profile="${SECURITY_PROFILE:-$DEFAULT_PROFILE}"
    
    log_info "Starting server..."
    log_info "  Port: $port"
    log_info "  Profile: $profile"
    log_info "  Log: $LOG_FILE"
    
    # Start server in background
    PORT="$port" SECURITY_PROFILE="$profile" \
        bun run server/main.ts > "$LOG_FILE" 2>&1 &
    
    local pid=$!
    echo "$pid" > "$PID_FILE"
    
    # Wait for server to start
    sleep 2
    
    if kill -0 "$pid" 2>/dev/null; then
        log_info "Server started (PID: $pid)"
        
        # Test health endpoint
        if curl -s "http://localhost:$port/health" > /dev/null 2>&1; then
            log_info "Health check: OK"
        else
            log_warn "Health check: Failed (check logs: tail -f $LOG_FILE)"
        fi
    else
        rm -f "$PID_FILE"
        log_error "Server failed to start (check logs: tail -f $LOG_FILE)"
        exit 1
    fi
}

# Restart server
restart() {
    log_info "Restarting server..."
    stop || true
    sleep 1
    start
}

# Show status
status() {
    if is_running; then
        local pid
        pid=$(cat "$PID_FILE")
        log_info "Server is running (PID: $pid)"
        
        # Try to get health status
        local port="${PORT:-$DEFAULT_PORT}"
        if command -v curl >/dev/null 2>&1; then
            echo ""
            echo "Health endpoint:"
            curl -s "http://localhost:$port/health" | jq . 2>/dev/null || \
                curl -s "http://localhost:$port/health"
        fi
    else
        log_warn "Server is not running"
        exit 1
    fi
}

# Show logs
logs() {
    if [[ -f "$LOG_FILE" ]]; then
        tail -f "$LOG_FILE"
    else
        log_error "Log file not found: $LOG_FILE"
        exit 1
    fi
}

# Test endpoint
test_endpoint() {
    local port="${PORT:-$DEFAULT_PORT}"
    local endpoint="${1:-/health}"
    local auth="${2:-}"
    
    if ! is_running; then
        log_error "Server not running"
        exit 1
    fi
    
    local url="http://localhost:$port$endpoint"
    
    if [[ -n "$auth" ]]; then
        curl -s -H "Authorization: Bearer $auth" "$url" | jq .
    else
        curl -s "$url" | jq .
    fi
}

# Usage
usage() {
    cat << 'USAGE'
Usage: ./server-ctl.sh <command> [options]

Commands:
  start       Start the server
  stop        Stop the server
  restart     Restart the server
  status      Show server status
  logs        Follow server logs
  test        Test endpoint (default: /health)

Environment Variables:
  PORT                Port to bind (default: 3001)
  SECURITY_PROFILE    Security profile (default: feeling-lucky)
  API_TOKEN_<CLIENT>  Bearer tokens for clients
  PID_FILE            PID file location (default: .server.pid)
  LOG_FILE            Log file location (default: .server.log)

Examples:
  # Start server on default port (3001) with feeling-lucky profile
  ./server-ctl.sh start

  # Start with custom port and profile
  PORT=3100 SECURITY_PROFILE=im-aware API_TOKEN_TEST=secret123 ./server-ctl.sh start

  # Test health endpoint
  ./server-ctl.sh test /health

  # Test with bearer token
  ./server-ctl.sh test /vaults test-token-12345

  # View logs
  ./server-ctl.sh logs

  # Restart server
  ./server-ctl.sh restart

  # Stop server
  ./server-ctl.sh stop
USAGE
}

# Main
case "${1:-}" in
    start)
        start
        ;;
    stop)
        stop
        ;;
    restart)
        restart
        ;;
    status)
        status
        ;;
    logs)
        logs
        ;;
    test)
        test_endpoint "${2:-/health}" "${3:-}"
        ;;
    *)
        usage
        exit 1
        ;;
esac

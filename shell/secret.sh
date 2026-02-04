# secret.sh - Shell integration for vaultwarden-secrets
# Portable: works in bash and zsh
#
# Source this file in your .zshrc or .bashrc:
#   source ~/.config/pai/lib/secrets/shell/secret.sh

# =============================================================================
# Configuration
# =============================================================================

# Path to the secret CLI (auto-detected)
if [ -z "$SECRET_CLI" ]; then
  if command -v secret > /dev/null 2>&1; then
    SECRET_CLI="secret"
  elif [ -x "$HOME/.config/pai/bin/secret" ]; then
    SECRET_CLI="$HOME/.config/pai/bin/secret"
  elif [ -x "$HOME/.config/pai-private/bin/secret" ]; then
    SECRET_CLI="$HOME/.config/pai-private/bin/secret"
  elif [ -n "$VAULTWARDEN_SECRETS_PATH" ] && [ -x "$VAULTWARDEN_SECRETS_PATH/bin/secret" ]; then
    SECRET_CLI="bun run $VAULTWARDEN_SECRETS_PATH/bin/secret"
  else
    SECRET_CLI="secret"
  fi
fi

# =============================================================================
# Muscle Memory Aliases (2-3 characters for speed)
# =============================================================================

alias sg="$SECRET_CLI get"
alias ss="$SECRET_CLI set"
alias sl="$SECRET_CLI list"
alias sc="$SECRET_CLI copy"
alias sv="$SECRET_CLI vault"
alias sth="$SECRET_CLI health"

# =============================================================================
# Shell Functions
# =============================================================================

# se - Secret Export to environment variable
# Usage: se "path" [VAR_NAME]
se() {
  local path="$1"
  local var_name="$2"

  if [ -z "$var_name" ]; then
    # Generate var name from path: PostgreSQL.password -> POSTGRESQL_PASSWORD
    var_name=$(echo "$path" | tr '.' '_' | tr '[:lower:]' '[:upper:]')
  fi

  local value
  value=$("$SECRET_CLI" get "$path" 2>/dev/null)

  if [ $? -eq 0 ] && [ -n "$value" ]; then
    export "${var_name}=${value}"
    echo "✓ Exported ${var_name}"
  else
    echo "✗ Failed to get secret: $path" >&2
    return 1
  fi
}

# sp - Secret Pick (interactive fzf picker)
# Usage: sp [action]
sp() {
  local action="${1:-get}"

  if ! command -v fzf > /dev/null 2>&1; then
    echo "sp requires fzf. Install with: brew install fzf" >&2
    return 1
  fi

  local selected
  selected=$("$SECRET_CLI" list | fzf --height 40% --reverse --prompt="secret> ")

  if [ -n "$selected" ]; then
    "$SECRET_CLI" "$action" "$selected"
  fi
}

# secret_export - Export secret as environment variable (verbose name for scripts)
# Usage: secret_export VAR_NAME "path"
secret_export() {
  local var_name="$1"
  local secret_path="$2"

  if [ -z "$var_name" ] || [ -z "$secret_path" ]; then
    echo "Usage: secret_export VAR_NAME \"secret/path\"" >&2
    return 1
  fi

  local value
  value=$("$SECRET_CLI" get "$secret_path" 2>/dev/null)

  if [ $? -eq 0 ] && [ -n "$value" ]; then
    export "${var_name}=${value}"
  else
    echo "Failed to get secret: $secret_path" >&2
    return 1
  fi
}

# =============================================================================
# Completion (shell-specific)
# =============================================================================

# Zsh completion (using eval to hide zsh syntax from bash parser)
if [ -n "$ZSH_VERSION" ]; then
  eval '
  _secret_completion() {
    local state

    _arguments \
      "1:command:(get copy paste set list search show vault cache health version help)" \
      "*:secret:->secrets"

    case $state in
      secrets)
        local -a secrets
        secrets=("${(@f)$($SECRET_CLI list 2>/dev/null)}")
        _describe "secrets" secrets
        ;;
    esac
  }

  compdef _secret_completion secret
  compdef _secret_completion sg
  compdef _secret_completion sc
  '
fi

# Bash completion
if [ -n "$BASH_VERSION" ]; then
  _secret_bash_completion() {
    local cur prev
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"

    if [ "${COMP_CWORD}" -eq 1 ]; then
      COMPREPLY=( $(compgen -W "get copy paste set list search show vault cache health version help" -- "$cur") )
    elif [ "${COMP_CWORD}" -eq 2 ]; then
      case "$prev" in
        get|copy|paste|set|show|search)
          local secrets
          secrets=$("$SECRET_CLI" list 2>/dev/null)
          COMPREPLY=( $(compgen -W "$secrets" -- "$cur") )
          ;;
        vault)
          COMPREPLY=( $(compgen -W "list use current" -- "$cur") )
          ;;
        cache)
          COMPREPLY=( $(compgen -W "clear stats refresh" -- "$cur") )
          ;;
      esac
    fi
  }

  complete -F _secret_bash_completion secret sg ss sl sc sv se sp
fi

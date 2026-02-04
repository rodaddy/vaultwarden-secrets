#!/usr/bin/env bash

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m' # No Color

# Default values
DRY_RUN=false
UNINSTALL=false
PAI_MODE=""
CUSTOM_DIR=""
CONFIG_DIR=""

# Script name for messages
SCRIPT_NAME="vaultwarden-secrets"

# Print colored output
print_color() {
    local color=$1
    shift
    echo -e "${color}$*${NC}"
}

# Print header with box
print_header() {
    echo
    print_color "$BOLD" "╔════════════════════════════════════════════╗"
    print_color "$BOLD" "║       Vaultwarden Secrets Installer       ║"
    print_color "$BOLD" "╚════════════════════════════════════════════╝"
    echo
}

# Show usage
show_help() {
    cat << EOF
$(print_color "$BOLD" "Usage:")
  ./install.sh [options]

$(print_color "$BOLD" "Options:")
  --dry-run       Show what would be done without making changes
  --uninstall     Remove installation
  --pai           Force PAI private mode (install to ~/.config/pai-private/)
  --no-pai        Force standard mode (install to ~/.config/)
  --dir <path>    Custom installation directory
  --help          Show this help message

$(print_color "$BOLD" "Detection priority (deepest first):")
  1. Custom --dir path if specified
  2. ~/.config/pai-private/vaultwarden-secrets/ if PAI detected + confirmed
  3. ~/.config/pai/vaultwarden-secrets/ as alternative PAI path
  4. ~/.config/vaultwarden-secrets/ as default

$(print_color "$BOLD" "Examples:")
  ./install.sh                    # Auto-detect best location
  ./install.sh --pai              # Force PAI private installation
  ./install.sh --dir ~/custom     # Install to custom directory
  ./install.sh --dry-run          # Preview what would happen
  ./install.sh --uninstall        # Remove installation

$(print_color "$BOLD" "Environment:")
  VAULTWARDEN_SECRETS_DIR         Override config directory location
EOF
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --uninstall)
            UNINSTALL=true
            shift
            ;;
        --pai)
            PAI_MODE="private"
            shift
            ;;
        --no-pai)
            PAI_MODE="none"
            shift
            ;;
        --dir)
            CUSTOM_DIR="$2"
            shift 2
            ;;
        --help|-h)
            print_header
            show_help
            exit 0
            ;;
        *)
            print_color "$RED" "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Detect PAI installation
detect_pai() {
    if [[ "$PAI_MODE" == "none" ]]; then
        return 1
    fi

    if [[ "$PAI_MODE" == "private" ]]; then
        return 0
    fi

    # Auto-detect PAI
    if [[ -d "$HOME/.config/pai-private" ]] || [[ -d "$HOME/.config/pai" ]]; then
        return 0
    fi

    return 1
}

# Determine installation directory
determine_config_dir() {
    # 1. Custom directory takes precedence
    if [[ -n "$CUSTOM_DIR" ]]; then
        # Expand ~ if present
        if [[ "$CUSTOM_DIR" == "~"* ]]; then
            CONFIG_DIR="${HOME}${CUSTOM_DIR:1}"
        else
            CONFIG_DIR="$CUSTOM_DIR"
        fi
        print_color "$BLUE" "→ Using custom directory: $CONFIG_DIR"
        return
    fi

    # 2. Check for PAI
    if detect_pai; then
        # Try private first
        if [[ -d "$HOME/.config/pai-private" ]] || [[ "$PAI_MODE" == "private" ]]; then
            CONFIG_DIR="$HOME/.config/pai-private/vaultwarden-secrets"
            print_color "$BLUE" "→ PAI detected, using private: $CONFIG_DIR"
        else
            CONFIG_DIR="$HOME/.config/pai/vaultwarden-secrets"
            print_color "$BLUE" "→ PAI detected, using public: $CONFIG_DIR"
        fi
        return
    fi

    # 3. Default location
    CONFIG_DIR="$HOME/.config/vaultwarden-secrets"
    print_color "$BLUE" "→ Using default location: $CONFIG_DIR"
}

# Check dependencies
check_dependencies() {
    local missing_deps=()

    # Check for bun
    if ! command -v bun &> /dev/null; then
        missing_deps+=("bun")
    fi

    # Check for bw CLI
    if ! command -v bw &> /dev/null; then
        missing_deps+=("bw (Bitwarden CLI)")
    fi

    if [[ ${#missing_deps[@]} -gt 0 ]]; then
        print_color "$YELLOW" "⚠ Missing dependencies:"
        for dep in "${missing_deps[@]}"; do
            print_color "$DIM" "  - $dep"
        done
        echo
        print_color "$YELLOW" "Install instructions:"
        if [[ " ${missing_deps[*]} " =~ " bun " ]]; then
            print_color "$DIM" "  bun:  curl -fsSL https://bun.sh/install | bash"
        fi
        if [[ " ${missing_deps[*]} " =~ " bw " ]]; then
            print_color "$DIM" "  bw:   brew install bitwarden-cli"
        fi
        echo
        if [[ "$DRY_RUN" != true ]]; then
            read -p "Continue anyway? [y/N] " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                print_color "$RED" "Installation cancelled"
                exit 1
            fi
        fi
    else
        print_color "$GREEN" "✓ All dependencies found"
    fi
}

# Create default config
create_default_config() {
    cat << 'EOF'
{
  "version": "1.0.0",
  "defaultVault": "default",
  "vaults": {}
}
EOF
}

# Perform installation
do_install() {
    print_color "$BOLD" "Installing $SCRIPT_NAME..."
    echo

    # Check dependencies
    check_dependencies
    echo

    # Determine config directory
    determine_config_dir
    echo

    local config_file="$CONFIG_DIR/config.json"

    if [[ "$DRY_RUN" == true ]]; then
        print_color "$YELLOW" "DRY RUN - Would perform:"
        echo
    fi

    # Create directory
    if [[ -d "$CONFIG_DIR" ]]; then
        print_color "$DIM" "  Directory exists: $CONFIG_DIR"
    else
        if [[ "$DRY_RUN" == true ]]; then
            print_color "$DIM" "  Would create: $CONFIG_DIR (mode: 700)"
        else
            mkdir -p "$CONFIG_DIR"
            chmod 700 "$CONFIG_DIR"
            print_color "$GREEN" "  ✓ Created: $CONFIG_DIR"
        fi
    fi

    # Create config file
    if [[ -f "$config_file" ]]; then
        print_color "$YELLOW" "  Config exists: $config_file (skipping)"
    else
        if [[ "$DRY_RUN" == true ]]; then
            print_color "$DIM" "  Would create: $config_file (mode: 600)"
            echo
            print_color "$DIM" "  With content:"
            create_default_config | sed 's/^/    /'
        else
            create_default_config > "$config_file"
            chmod 600 "$config_file"
            print_color "$GREEN" "  ✓ Created: $config_file"
        fi
    fi

    echo
    if [[ "$DRY_RUN" == true ]]; then
        print_color "$YELLOW" "DRY RUN complete - no changes made"
    else
        print_color "$GREEN" "✅ Installation complete!"
        echo
        print_color "$BOLD" "Next steps:"
        print_color "$DIM" "  1. Unlock Bitwarden:   bw unlock"
        print_color "$DIM" "  2. Store session:      bun run set-session default YOUR_SESSION_TOKEN"
        print_color "$DIM" "  3. Test a secret:      bun run get MyItem.password"
        echo
        print_color "$BOLD" "Configuration:"
        print_color "$DIM" "  Config directory: $CONFIG_DIR"
        print_color "$DIM" "  Override with:    export VAULTWARDEN_SECRETS_DIR=$CONFIG_DIR"

        if [[ "$CONFIG_DIR" == *"pai"* ]]; then
            echo
            print_color "$BOLD" "PAI Integration:"
            print_color "$DIM" "  Auto-detected when using the library"
            print_color "$DIM" "  Manual override: VAULTWARDEN_SECRETS_DIR=$CONFIG_DIR"
        fi
    fi
}

# Perform uninstallation
do_uninstall() {
    print_color "$BOLD" "Uninstalling $SCRIPT_NAME..."
    echo

    # Determine config directory
    determine_config_dir
    echo

    if [[ ! -d "$CONFIG_DIR" ]]; then
        print_color "$YELLOW" "Nothing to remove - directory does not exist"
        exit 0
    fi

    if [[ "$DRY_RUN" == true ]]; then
        print_color "$YELLOW" "DRY RUN - Would remove:"
        echo
        print_color "$DIM" "  $CONFIG_DIR/"
        if [[ -f "$CONFIG_DIR/config.json" ]]; then
            print_color "$DIM" "    - config.json"
        fi
        if [[ -f "$CONFIG_DIR/cache.json" ]]; then
            print_color "$DIM" "    - cache.json"
        fi
    else
        print_color "$YELLOW" "This will remove:"
        print_color "$DIM" "  $CONFIG_DIR/"
        echo
        print_color "$YELLOW" "Note: Keychain entries must be removed manually"
        echo
        read -p "Are you sure? [y/N] " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            rm -rf "$CONFIG_DIR"
            print_color "$GREEN" "✅ Uninstalled successfully"
            echo
            print_color "$DIM" "To remove Keychain entries, use:"
            print_color "$DIM" "  security delete-generic-password -s \"vaultwarden-secrets\" -a \"vault-name\""
        else
            print_color "$RED" "Uninstall cancelled"
            exit 1
        fi
    fi
}

# Main execution
main() {
    print_header

    if [[ "$UNINSTALL" == true ]]; then
        do_uninstall
    else
        do_install
    fi
}

# Run main function
main
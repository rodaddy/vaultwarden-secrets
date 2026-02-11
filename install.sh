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
INSTALL_MODE="bundle"  # "bundle" or "clone"
SKIP_DEPS=false
VAULT_SERVER="${VAULTWARDEN_SERVER:-}"  # From env or prompt
REPO_URL="${VW_SECRETS_REPO:-}"         # From env or prompt
VERSION="0.5.2"

# Installation paths
INSTALL_DIR=""  # Will be set to ~/.config/pai/lib/secrets or custom

# Script name for messages
SCRIPT_NAME="vaultwarden-secrets"

# Detect OS and package manager
OS=""
PKG_MANAGER=""

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

$(print_color "$BOLD" "Installation Modes:")
  --clone         Clone from GitHub (requires git, GitHub access)
  --bundle        Install from current directory (default)

$(print_color "$BOLD" "Options:")
  --dry-run       Show what would be done without making changes
  --uninstall     Remove installation
  --skip-deps     Skip dependency installation (bun, bw)
  --pai           Force PAI private mode (install to ~/.config/pai-private/)
  --no-pai        Force standard mode (install to ~/.config/)
  --dir <path>    Custom installation directory
  --server <url>  Set Vaultwarden server URL (default: https://vaultwarden.rodaddy.live)
  --help          Show this help message

$(print_color "$BOLD" "Installation Paths:")
  Config:  Auto-detected from PAI or ~/.config/vaultwarden-secrets/
  Source:  ~/.config/pai/lib/secrets/ (or custom with --dir)

$(print_color "$BOLD" "Examples:")
  ./install.sh                              # Full install from current dir
  ./install.sh --clone                      # Clone from GitHub and install
  ./install.sh --skip-deps                  # Skip bun/bw installation
  ./install.sh --dry-run                    # Preview what would happen
  ./install.sh --server https://custom.com  # Custom Vaultwarden server
  ./install.sh --uninstall                  # Remove installation

$(print_color "$BOLD" "Remote Installation:")
  curl -fsSL https://raw.githubusercontent.com/rodaddy/vaultwarden-secrets/main/install.sh | bash -s -- --clone

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
        --clone)
            INSTALL_MODE="clone"
            shift
            ;;
        --bundle)
            INSTALL_MODE="bundle"
            shift
            ;;
        --skip-deps)
            SKIP_DEPS=true
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
        --server)
            VAULT_SERVER="$2"
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

# Check if command exists
command_exists() {
    command -v "$1" &> /dev/null
}

# Detect operating system
detect_os() {
    case "$(uname -s)" in
        Darwin*)
            OS="macos"
            if command_exists brew; then
                PKG_MANAGER="brew"
            fi
            ;;
        Linux*)
            OS="linux"
            if command_exists apt-get; then
                PKG_MANAGER="apt"
            elif command_exists dnf; then
                PKG_MANAGER="dnf"
            elif command_exists yum; then
                PKG_MANAGER="yum"
            elif command_exists pacman; then
                PKG_MANAGER="pacman"
            fi
            ;;
        *)
            OS="unknown"
            ;;
    esac
    print_color "$GREEN" "✓ Detected: $OS${PKG_MANAGER:+ ($PKG_MANAGER)}"
}

# Install bun runtime
install_bun() {
    if command_exists bun; then
        print_color "$GREEN" "✓ bun already installed: $(bun --version)"
        return 0
    fi

    print_color "$BLUE" "→ Installing bun..."

    if [[ "$DRY_RUN" == true ]]; then
        print_color "$DIM" "  Would run: curl -fsSL https://bun.sh/install | bash"
        return 0
    fi

    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"

    if command_exists bun; then
        print_color "$GREEN" "✓ bun installed successfully"
    else
        print_color "$RED" "✗ bun installation failed"
        return 1
    fi
}

# Install Bitwarden CLI
install_bw() {
    if command_exists bw; then
        print_color "$GREEN" "✓ Bitwarden CLI already installed: $(bw --version)"
        return 0
    fi

    print_color "$BLUE" "→ Installing Bitwarden CLI..."

    if [[ "$DRY_RUN" == true ]]; then
        print_color "$DIM" "  Would install bitwarden-cli via $PKG_MANAGER"
        return 0
    fi

    case "$PKG_MANAGER" in
        brew)
            brew install bitwarden-cli
            ;;
        apt)
            sudo snap install bw
            ;;
        *)
            print_color "$YELLOW" "⚠ Please install Bitwarden CLI manually:"
            print_color "$DIM" "  https://bitwarden.com/help/cli/"
            return 1
            ;;
    esac

    if command_exists bw; then
        print_color "$GREEN" "✓ Bitwarden CLI installed successfully"
    else
        print_color "$RED" "✗ Bitwarden CLI installation failed"
        return 1
    fi
}

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

# Prompt for vault server URL
prompt_vault_server() {
    if [[ -n "$VAULT_SERVER" ]]; then
        print_color "$GREEN" "✓ Vault server: $VAULT_SERVER"
        return 0
    fi

    if [[ "$DRY_RUN" == true ]]; then
        VAULT_SERVER="https://vault.example.com"
        print_color "$DIM" "  Would prompt for vault server URL"
        return 0
    fi

    echo ""
    print_color "$BOLD" "Vaultwarden Server Configuration"
    print_color "$DIM" "Enter your Vaultwarden/Bitwarden server URL"
    print_color "$DIM" "Examples:"
    print_color "$DIM" "  - https://vault.example.com"
    print_color "$DIM" "  - https://bitwarden.com (official cloud)"
    echo ""
    read -p "Server URL: " VAULT_SERVER

    if [[ -z "$VAULT_SERVER" ]]; then
        print_color "$RED" "✗ Vault server URL required"
        exit 1
    fi

    print_color "$GREEN" "✓ Will configure: $VAULT_SERVER"
}

# Determine installation directory for source files
determine_install_dir() {
    # Check if PAI structure exists
    if [[ -d "$HOME/.config/pai" ]]; then
        INSTALL_DIR="$HOME/.config/pai/lib/secrets"
        print_color "$BLUE" "→ Using PAI location: $INSTALL_DIR"
    else
        INSTALL_DIR="$HOME/.local/lib/vaultwarden-secrets"
        print_color "$BLUE" "→ Using standard location: $INSTALL_DIR"
    fi
}

# Install source files
install_source() {
    determine_install_dir

    if [[ "$INSTALL_MODE" == "clone" ]]; then
        # Clone from Git
        if [[ -z "$REPO_URL" ]]; then
            print_color "$RED" "✗ Git repository URL not set"
            print_color "$DIM" "  Set via: export VW_SECRETS_REPO=https://github.com/user/repo.git"
            exit 1
        fi

        print_color "$BLUE" "→ Cloning from: $REPO_URL"

        if [[ "$DRY_RUN" == true ]]; then
            print_color "$DIM" "  Would clone: git clone $REPO_URL $INSTALL_DIR"
            return 0
        fi

        if [[ -d "$INSTALL_DIR" ]]; then
            print_color "$YELLOW" "  Existing installation found"
            read -p "Remove and reinstall? [y/N] " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                rm -rf "$INSTALL_DIR"
            else
                print_color "$RED" "Installation cancelled"
                exit 1
            fi
        fi

        mkdir -p "$(dirname "$INSTALL_DIR")"
        git clone "$REPO_URL" "$INSTALL_DIR"
        print_color "$GREEN" "✓ Cloned source successfully"

    else
        # Bundle mode - copy from current directory
        print_color "$BLUE" "→ Installing from current directory"

        if [[ ! -f "package.json" ]]; then
            print_color "$RED" "✗ Not in vaultwarden-secrets directory"
            print_color "$DIM" "  Run from extracted tarball or use --clone"
            exit 1
        fi

        if [[ "$DRY_RUN" == true ]]; then
            print_color "$DIM" "  Would copy: $(pwd) → $INSTALL_DIR"
            return 0
        fi

        if [[ -d "$INSTALL_DIR" ]]; then
            print_color "$YELLOW" "  Updating existing installation"
        fi

        mkdir -p "$INSTALL_DIR"
        # Use rsync to handle permissions and exclude unnecessary files
        rsync -a --delete \
            --exclude='.git' \
            --exclude='node_modules' \
            --exclude='.reports' \
            --exclude='.working' \
            . "$INSTALL_DIR/"
        print_color "$GREEN" "✓ Source installed successfully"
    fi
}

# Create symlink to make 'secret' available in PATH
setup_binary_symlink() {
    local bin_dir="$HOME/.local/bin"
    local target_binary="$INSTALL_DIR/bin/secret"
    local symlink_path="$bin_dir/secret"

    print_color "$BLUE" "→ Setting up binary symlink..."

    if [[ "$DRY_RUN" == true ]]; then
        print_color "$DIM" "  Would create: $symlink_path → $target_binary"
        print_color "$DIM" "  Would add $bin_dir to PATH in shell rc"
        return 0
    fi

    # Create bin directory if needed
    mkdir -p "$bin_dir"

    # Remove existing symlink or file
    if [[ -L "$symlink_path" ]] || [[ -f "$symlink_path" ]]; then
        rm -f "$symlink_path"
    fi

    # Create symlink
    ln -s "$target_binary" "$symlink_path"
    print_color "$GREEN" "✓ Created symlink: $symlink_path"

    # Check if ~/.local/bin is in PATH
    local shell_rc=""
    if [[ -n "${ZSH_VERSION:-}" ]] || [[ "$SHELL" == *zsh ]]; then
        shell_rc="$HOME/.zshrc"
    elif [[ -n "${BASH_VERSION:-}" ]] || [[ "$SHELL" == *bash ]]; then
        shell_rc="$HOME/.bashrc"
    fi

    if [[ -n "$shell_rc" ]]; then
        if ! grep -q 'export PATH=.*\.local/bin' "$shell_rc" 2>/dev/null && \
           ! grep -q 'PATH=.*\.local/bin' "$shell_rc" 2>/dev/null; then
            echo "" >> "$shell_rc"
            echo '# Local binaries' >> "$shell_rc"
            echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$shell_rc"
            print_color "$GREEN" "✓ Added ~/.local/bin to PATH in $shell_rc"
        else
            print_color "$GREEN" "✓ ~/.local/bin already in PATH"
        fi
    fi
}

# Compile biometric authentication helper (macOS only)
compile_biometric_auth() {
    # Only on macOS
    if [[ "$OSTYPE" != "darwin"* ]]; then
        print_color "$DIM" "  Biometric auth: skipped (macOS only)"
        return 0
    fi

    local swift_source="$INSTALL_DIR/bin/biometric-auth.swift"
    local binary_target="$INSTALL_DIR/bin/biometric-auth"

    if [[ ! -f "$swift_source" ]]; then
        print_color "$DIM" "  Biometric auth: source not found"
        return 0
    fi

    if [[ "$DRY_RUN" == true ]]; then
        print_color "$DIM" "  Would compile: $swift_source → $binary_target"
        return 0
    fi

    print_color "$BLUE" "→ Compiling Touch ID / Apple Watch authentication..."

    if swiftc -O -o "$binary_target" "$swift_source" \
        -framework LocalAuthentication -framework Security 2>/dev/null; then
        chmod +x "$binary_target"
        print_color "$GREEN" "✓ Biometric auth compiled successfully"
        print_color "$DIM" "  Enable with: secret unlock --save"
    else
        print_color "$YELLOW" "⚠ Biometric auth compilation failed (optional feature)"
        print_color "$DIM" "  You can still use password-based unlock"
    fi
}

# Setup shell integration
setup_shell_integration() {
    local shell_rc=""
    local shell_name=""

    # Detect shell
    if [[ -n "${ZSH_VERSION:-}" ]] || [[ "$SHELL" == *zsh ]]; then
        shell_rc="$HOME/.zshrc"
        shell_name="zsh"
    elif [[ -n "${BASH_VERSION:-}" ]] || [[ "$SHELL" == *bash ]]; then
        shell_rc="$HOME/.bashrc"
        shell_name="bash"
    else
        print_color "$YELLOW" "⚠ Unknown shell - skipping shell integration"
        print_color "$DIM" "  Manually add to your shell rc file:"
        print_color "$DIM" "    [ -f $INSTALL_DIR/shell/secret.sh ] && source $INSTALL_DIR/shell/secret.sh"
        return 0
    fi

    print_color "$BLUE" "→ Setting up $shell_name integration..."

    local integration_line="[ -f $INSTALL_DIR/shell/secret.sh ] && source $INSTALL_DIR/shell/secret.sh"

    if [[ "$DRY_RUN" == true ]]; then
        print_color "$DIM" "  Would add to $shell_rc:"
        print_color "$DIM" "    $integration_line"
        return 0
    fi

    if grep -qF "$INSTALL_DIR/shell/secret.sh" "$shell_rc" 2>/dev/null; then
        print_color "$GREEN" "✓ Shell integration already configured"
    else
        echo "" >> "$shell_rc"
        echo "# vaultwarden-secrets CLI" >> "$shell_rc"
        echo "$integration_line" >> "$shell_rc"
        print_color "$GREEN" "✓ Added shell integration to $shell_rc"
        print_color "$YELLOW" "  Run: source $shell_rc (or restart shell)"
    fi
}

# Configure Bitwarden CLI
configure_bitwarden() {
    if ! command_exists bw; then
        print_color "$YELLOW" "⚠ Bitwarden CLI not installed - skipping configuration"
        return 0
    fi

    print_color "$BLUE" "→ Configuring Bitwarden CLI..."

    if [[ "$DRY_RUN" == true ]]; then
        print_color "$DIM" "  Would run: bw config server $VAULT_SERVER"
        return 0
    fi

    local current_server
    current_server=$(bw config server 2>&1 || echo "")

    if [[ "$current_server" == "$VAULT_SERVER" ]]; then
        print_color "$GREEN" "✓ Already configured for $VAULT_SERVER"
    else
        if bw config server "$VAULT_SERVER" 2>&1 | grep -q "Logout required"; then
            print_color "$YELLOW" "⚠ Server already configured (logout required to change)"
            print_color "$DIM" "  Current server: $current_server"
        else
            print_color "$GREEN" "✓ Configured for $VAULT_SERVER"
        fi
    fi
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
    print_color "$BOLD" "Installing $SCRIPT_NAME v$VERSION..."
    echo

    # 1. Detect OS
    detect_os
    echo

    # 2. Prompt for vault server if needed
    prompt_vault_server
    echo

    # 3. Install dependencies (unless skipped)
    if [[ "$SKIP_DEPS" != true ]]; then
        print_color "$BOLD" "Installing dependencies..."
        echo
        install_bun || {
            print_color "$YELLOW" "⚠ bun installation failed - continuing anyway"
        }
        echo
        install_bw || {
            print_color "$YELLOW" "⚠ Bitwarden CLI installation failed - continuing anyway"
        }
        echo
    else
        print_color "$YELLOW" "⚠ Skipping dependency installation (--skip-deps)"
        echo
    fi

    # 4. Install source files
    print_color "$BOLD" "Installing source files..."
    echo
    install_source
    echo

    # 5. Setup binary symlink
    setup_binary_symlink
    echo

    # 6. Compile biometric auth (macOS)
    compile_biometric_auth
    echo

    # 7. Setup config directory
    print_color "$BOLD" "Setting up configuration..."
    echo
    determine_config_dir
    echo

    local config_file="$CONFIG_DIR/config.json"

    if [[ "$DRY_RUN" == true ]]; then
        print_color "$YELLOW" "DRY RUN - Would perform:"
        echo
    fi

    # Create config directory
    if [[ -d "$CONFIG_DIR" ]]; then
        print_color "$GREEN" "✓ Config directory exists: $CONFIG_DIR"
    else
        if [[ "$DRY_RUN" == true ]]; then
            print_color "$DIM" "  Would create: $CONFIG_DIR (mode: 700)"
        else
            mkdir -p "$CONFIG_DIR"
            chmod 700 "$CONFIG_DIR"
            print_color "$GREEN" "✓ Created config directory: $CONFIG_DIR"
        fi
    fi

    # Create config file
    if [[ -f "$config_file" ]]; then
        print_color "$GREEN" "✓ Config file exists: $config_file"
    else
        if [[ "$DRY_RUN" == true ]]; then
            print_color "$DIM" "  Would create: $config_file (mode: 600)"
        else
            create_default_config > "$config_file"
            chmod 600 "$config_file"
            print_color "$GREEN" "✓ Created config file: $config_file"
        fi
    fi

    echo

    # 8. Setup shell integration
    print_color "$BOLD" "Setting up shell integration..."
    echo
    setup_shell_integration
    echo

    # 9. Configure Bitwarden
    print_color "$BOLD" "Configuring Bitwarden CLI..."
    echo
    configure_bitwarden
    echo

    # Done!
    if [[ "$DRY_RUN" == true ]]; then
        print_color "$YELLOW" "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        print_color "$YELLOW" "DRY RUN complete - no changes made"
        print_color "$YELLOW" "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    else
        print_color "$GREEN" "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        print_color "$GREEN" "✅ Installation complete!"
        print_color "$GREEN" "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo
        print_color "$BOLD" "Next steps:"
        print_color "$DIM" "  1. Login to vault:        bw login your@email.com"
        print_color "$DIM" "  2. Unlock with Touch ID:  secret unlock --save"
        print_color "$DIM" "     (or manual:            secret unlock)"
        print_color "$DIM" "  3. Test a secret:         secret get \"Item Name\""
        echo
        print_color "$BOLD" "Installed at:"
        print_color "$DIM" "  Source:  $INSTALL_DIR"
        print_color "$DIM" "  Config:  $CONFIG_DIR"
        print_color "$DIM" "  Vault:   $VAULT_SERVER"
        echo
        print_color "$BOLD" "Shell aliases (after sourcing shell rc):"
        print_color "$DIM" "  sg  = secret get"
        print_color "$DIM" "  sc  = secret copy"
        print_color "$DIM" "  ss  = secret set"
        print_color "$DIM" "  sl  = secret list"
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
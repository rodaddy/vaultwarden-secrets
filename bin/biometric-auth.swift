#!/usr/bin/env swift
// biometric-auth.swift - Touch ID / Apple Watch authentication for secrets
// Returns the stored password on successful biometric auth

import Foundation
import LocalAuthentication
import Security

let serviceName = "vaultwarden-secrets"
let accountName = "master-password"

func getPasswordWithBiometrics() -> String? {
    let context = LAContext()
    var error: NSError?

    // Check if biometrics available
    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
        fputs("Biometrics not available: \(error?.localizedDescription ?? "unknown")\n", stderr)
        return nil
    }

    // Query keychain with biometric protection
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: serviceName,
        kSecAttrAccount as String: accountName,
        kSecReturnData as String: true,
        kSecUseAuthenticationContext as String: context,
        kSecMatchLimit as String: kSecMatchLimitOne
    ]

    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)

    if status == errSecSuccess, let data = result as? Data, let password = String(data: data, encoding: .utf8) {
        return password
    } else if status == errSecItemNotFound {
        fputs("No password stored. Run: secret unlock --save\n", stderr)
        return nil
    } else {
        fputs("Keychain error: \(status)\n", stderr)
        return nil
    }
}

func storePasswordWithBiometrics(_ password: String) -> Bool {
    // Create access control with biometric protection
    guard let accessControl = SecAccessControlCreateWithFlags(
        nil,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        [.biometryCurrentSet, .or, .watch],
        nil
    ) else {
        fputs("Failed to create access control\n", stderr)
        return false
    }

    // Delete existing item first
    let deleteQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: serviceName,
        kSecAttrAccount as String: accountName
    ]
    SecItemDelete(deleteQuery as CFDictionary)

    // Add new item with biometric protection
    let addQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: serviceName,
        kSecAttrAccount as String: accountName,
        kSecValueData as String: password.data(using: .utf8)!,
        kSecAttrAccessControl as String: accessControl
    ]

    let status = SecItemAdd(addQuery as CFDictionary, nil)

    if status == errSecSuccess {
        return true
    } else {
        fputs("Failed to store password: \(status)\n", stderr)
        return false
    }
}

// Main
let args = CommandLine.arguments

if args.count > 1 && args[1] == "store" {
    // Read password from stdin
    guard let password = readLine(strippingNewline: true), !password.isEmpty else {
        fputs("No password provided\n", stderr)
        exit(1)
    }

    if storePasswordWithBiometrics(password) {
        fputs("Password stored with biometric protection\n", stderr)
        exit(0)
    } else {
        exit(1)
    }
} else {
    // Get password with biometrics
    if let password = getPasswordWithBiometrics() {
        print(password)
        exit(0)
    } else {
        exit(1)
    }
}

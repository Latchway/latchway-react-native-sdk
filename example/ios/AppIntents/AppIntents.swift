//
//  AppIntents.swift
//  AppIntents
//
//  Created by Peter Vu on 31/8/26.
//

import AppIntents
import Foundation

struct LatchwayDelegatedRequestIntent: AppIntent {
    static var title: LocalizedStringResource { "Latchway delegated request unavailable" }
    static var description = IntentDescription(
        "Reports that the React Native example does not yet expose a delegated component request path."
    )

    func perform() async throws -> some IntentResult {
        if Bundle.main.bundleURL.pathExtension == "appex" {
            throw LatchwayDelegatedRequestUnavailable()
        }
        return .result(dialog: "No delegated Latchway request was performed.")
    }
}

private struct LatchwayDelegatedRequestUnavailable: LocalizedError {
    var errorDescription: String? {
        "Delegated component requests are unsupported by this React Native example."
    }
}

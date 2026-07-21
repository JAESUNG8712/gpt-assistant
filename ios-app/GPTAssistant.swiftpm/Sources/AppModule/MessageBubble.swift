import SwiftUI

struct MessageBubble: View {
    let message: ChatMessage
    var onFeedback: (Int) -> Void

    private var canRateFeedback: Bool {
        message.role == .assistant && !message.isStreaming && !message.text.isEmpty
    }

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 40) }

            VStack(alignment: .leading, spacing: 6) {
                Text(displayText)
                    .textSelection(.enabled)

                if canRateFeedback {
                    HStack(spacing: 16) {
                        Button {
                            onFeedback(1)
                        } label: {
                            Image(systemName: message.feedbackSent == 1 ? "hand.thumbsup.fill" : "hand.thumbsup")
                        }
                        Button {
                            onFeedback(-1)
                        } label: {
                            Image(systemName: message.feedbackSent == -1 ? "hand.thumbsdown.fill" : "hand.thumbsdown")
                        }
                    }
                    .buttonStyle(.plain)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
            }
            .padding(12)
            .background(bubbleColor)
            .clipShape(RoundedRectangle(cornerRadius: 14))

            if message.role == .assistant { Spacer(minLength: 40) }
        }
    }

    private var displayText: String {
        if message.text.isEmpty && message.isStreaming {
            return "…"
        }
        return message.text
    }

    private var bubbleColor: Color {
        message.role == .user ? Color.accentColor.opacity(0.15) : Color.gray.opacity(0.15)
    }
}

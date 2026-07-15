import SwiftUI

@MainActor
struct ChatView: View {
    @EnvironmentObject private var settings: AppSettings

    @State private var personas: [Persona] = Persona.fallbackList
    @State private var messages: [ChatMessage] = []
    @State private var inputText: String = ""
    @State private var isSending = false
    @State private var errorMessage: String?
    @State private var showPersonaPicker = false
    @State private var streamTask: Task<Void, Never>?

    private var client: APIClient { APIClient(settings: settings) }

    private var selectedPersona: Persona {
        personas.first(where: { $0.id == settings.selectedPersonaID }) ?? personas[0]
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if settings.baseURL == nil {
                    Text("설정 탭에서 백엔드 서버 주소를 먼저 입력하세요.")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .padding(8)
                        .frame(maxWidth: .infinity)
                        .background(Color.orange.opacity(0.12))
                }

                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            ForEach(messages) { message in
                                MessageBubble(message: message) { rating in
                                    Task { await sendFeedback(for: message, rating: rating) }
                                }
                                .id(message.id)
                            }
                        }
                        .padding()
                    }
                    .onChange(of: messages.last?.text) { _ in
                        guard let last = messages.last else { return }
                        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .padding(.horizontal)
                }

                inputBar
            }
            .navigationTitle("\(selectedPersona.icon) \(selectedPersona.name)")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        Button("대화 이력 불러오기") { Task { await loadHistory() } }
                        Button("대화 지우기", role: .destructive) { Task { await clearHistory() } }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showPersonaPicker = true
                    } label: {
                        Image(systemName: "person.crop.circle")
                    }
                }
            }
            .sheet(isPresented: $showPersonaPicker) {
                PersonaPickerView(personas: personas, selectedID: $settings.selectedPersonaID)
            }
            .task {
                await loadPersonas()
            }
        }
    }

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("메시지를 입력하세요", text: $inputText, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...5)
                .disabled(isSending)

            Button {
                send()
            } label: {
                Image(systemName: isSending ? "stop.circle.fill" : "arrow.up.circle.fill")
                    .font(.system(size: 30))
            }
            .disabled(!isSending && inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding()
    }

    private func loadPersonas() async {
        guard settings.baseURL != nil else { return }
        do {
            let fetched = try await client.fetchPersonas()
            if !fetched.isEmpty { personas = fetched }
        } catch {
            // 서버 미설정/오프라인 상태에서는 fallbackList를 그대로 유지한다.
        }
    }

    private func loadHistory() async {
        guard settings.baseURL != nil else {
            errorMessage = "설정 탭에서 서버 주소를 먼저 입력하세요."
            return
        }
        do {
            let entries = try await client.fetchHistory(persona: settings.selectedPersonaID)
            messages = entries.map { entry in
                ChatMessage(role: entry.role == "user" ? .user : .assistant, text: entry.content)
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func clearHistory() async {
        guard settings.baseURL != nil else { return }
        do {
            try await client.clearHistory(persona: settings.selectedPersonaID)
            messages.removeAll()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func send() {
        if isSending {
            streamTask?.cancel()
            isSending = false
            return
        }

        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard settings.baseURL != nil else {
            errorMessage = "설정 탭에서 서버 주소를 먼저 입력하세요."
            return
        }

        inputText = ""
        errorMessage = nil
        messages.append(ChatMessage(role: .user, text: text))
        let assistantIndex = messages.count
        messages.append(ChatMessage(role: .assistant, text: "", isStreaming: true))

        isSending = true
        let persona = settings.selectedPersonaID
        let activeClient = client

        streamTask = Task {
            do {
                for try await chunk in activeClient.streamChat(message: text, persona: persona) {
                    if Task.isCancelled { break }
                    guard assistantIndex < messages.count else { break }
                    messages[assistantIndex].text += chunk
                }
            } catch {
                if !Task.isCancelled {
                    errorMessage = error.localizedDescription
                }
            }
            if assistantIndex < messages.count {
                messages[assistantIndex].isStreaming = false
            }
            isSending = false
        }
    }

    private func sendFeedback(for message: ChatMessage, rating: Int) async {
        guard let index = messages.firstIndex(where: { $0.id == message.id }) else { return }
        guard let userMessage = messages[..<index].last(where: { $0.role == .user }) else { return }
        do {
            try await client.sendFeedback(
                question: userMessage.text,
                answer: message.text,
                rating: rating,
                persona: settings.selectedPersonaID
            )
            messages[index].feedbackSent = rating
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

import SwiftUI

struct PersonaPickerView: View {
    let personas: [Persona]
    @Binding var selectedID: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(personas) { persona in
                Button {
                    selectedID = persona.id
                    dismiss()
                } label: {
                    HStack {
                        Text(persona.icon)
                            .font(.title2)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(persona.name)
                                .font(.headline)
                            Text(persona.description)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if persona.id == selectedID {
                            Image(systemName: "checkmark")
                                .foregroundStyle(.tint)
                        }
                    }
                }
                .foregroundStyle(.primary)
            }
            .navigationTitle("페르소나 선택")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("닫기") { dismiss() }
                }
            }
        }
    }
}

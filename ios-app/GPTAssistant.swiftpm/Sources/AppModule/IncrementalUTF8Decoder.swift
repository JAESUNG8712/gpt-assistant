import Foundation

/// `/chat`은 SSE가 아니라 순수 바이트 스트림(text/plain)이라, 임의 위치에서 잘린
/// 청크 경계가 멀티바이트 UTF-8 문자(한글 등)를 반으로 자를 수 있다.
/// 디코딩 가능한 가장 긴 접두사만 반환하고, 남은 바이트는 다음 청크와 합쳐 재시도한다.
final class IncrementalUTF8Decoder {
    private var carry: [UInt8] = []

    func decode(_ newBytes: [UInt8]) -> String {
        let buffer = carry + newBytes
        var validLength = buffer.count

        while validLength > 0 {
            if let text = String(bytes: buffer[0..<validLength], encoding: .utf8) {
                carry = validLength < buffer.count ? Array(buffer[validLength...]) : []
                return text
            }
            validLength -= 1
            // UTF-8 문자는 최대 4바이트이므로, 그 이상 뒤로 물러나도 안 되면
            // 잘림이 아니라 실제로 잘못된 인코딩이라는 뜻 — 무한 축소를 막는다.
            if buffer.count - validLength > 4 { break }
        }

        // 잘못된 바이트 시퀀스: 유실 없이 대체 문자로라도 표시하고 캐리를 비운다.
        carry = []
        return String(decoding: buffer, as: UTF8.self)
    }
}

import AppKit
import ImageIO
import Vision

func emit(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

func recognize(_ handler: VNImageRequestHandler) throws -> String? {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.automaticallyDetectsLanguage = true
    do {
        try handler.perform([request])
    } catch {
        throw NSError(domain: "Vision", code: 1, userInfo: [NSLocalizedDescriptionKey: "Cannot read image: Vision failed"])
    }
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    return lines.isEmpty ? nil : lines.joined(separator: "\n")
}

// Exercise distinct recognition scripts before accepting files. English alone
// leaves first-use model work for the first multilingual attachments.
for text in ["Context Compiler", "صباح الخير", "नमस्ते दुनिया", "안녕하세요", "Доброе утро", "สวัสดีครับ", "你好世界", "こんにちは世界"] {
    try autoreleasepool {
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 640, pixelsHigh: 160, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        NSColor.white.setFill()
        NSBezierPath(rect: NSRect(x: 0, y: 0, width: 640, height: 160)).fill()
        (text as NSString).draw(at: NSPoint(x: 20, y: 60), withAttributes: [.font: NSFont.systemFont(ofSize: 40), .foregroundColor: NSColor.black])
        NSGraphicsContext.restoreGraphicsState()
        // Use the production URL decoder. tmpfile is already unlinked, so
        // the OS also cleans it up if the host stops us during warm-up.
        guard let file = tmpfile() else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        defer { fclose(file) }
        let handle = FileHandle(fileDescriptor: fileno(file))
        try handle.write(contentsOf: bitmap.representation(using: .png, properties: [:])!)
        try handle.seek(toOffset: 0)
        let url = URL(fileURLWithPath: "/dev/fd/\(handle.fileDescriptor)")
        guard try recognize(VNImageRequestHandler(url: url)) == text else {
            throw NSError(domain: "Vision", code: 2, userInfo: [NSLocalizedDescriptionKey: "OCR warm-up did not recognize its text"])
        }
    }
}
emit(["ready": true])

while let line = readLine() {
    autoreleasepool {
        do {
            let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
            let url = URL(fileURLWithPath: request.path)
            guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else {
                throw NSError(domain: "Vision", code: 3, userInfo: [NSLocalizedDescriptionKey: "Cannot read image"])
            }
            // Preserve the small-image guard and let Vision read the URL's
            // orientation and colour metadata, as the previous reader did.
            for key in [kCGImagePropertyPixelWidth, kCGImagePropertyPixelHeight] {
                if let size = properties[key] as? Int, size < 3 {
                    emit(["text": NSNull()])
                    return
                }
            }
            let text = try recognize(VNImageRequestHandler(url: url))
            emit(["text": text as Any? ?? NSNull()])
        } catch {
            emit(["error": error.localizedDescription])
        }
    }
}

struct Request: Decodable { let path: String }

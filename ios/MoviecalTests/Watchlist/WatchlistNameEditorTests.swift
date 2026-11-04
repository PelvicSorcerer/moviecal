import XCTest
@testable import Moviecal

@MainActor
final class WatchlistNameEditorTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    private struct Token: AuthTokenProviding {
        func currentAccessToken() async throws -> String { "token" }
    }

    private func makeClient() -> APIClient {
        APIClient(
            environment: APIEnvironment(baseURL: URL(string: "https://api.moviecal.test")!),
            tokenProvider: Token(),
            session: MockURLProtocol.makeSession()
        )
    }

    private func respond(_ request: URLRequest, status: Int, body: String) -> (HTTPURLResponse, Data) {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        return (response, Data(body.utf8))
    }

    private func bodyString(_ request: URLRequest) -> String {
        guard let stream = request.httpBodyStream else { return "" }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return String(decoding: data, as: UTF8.self)
    }

    private func summaryJSON(name: String) -> String {
        #"{ "watchlist": { "id": "s1", "kind": "shared", "name": "\#(name)", "ownerUserId": "u1", "role": "owner", "canEdit": true } }"#
    }

    // MARK: - Validation

    func testValidatorTrimsAndAccepts() {
        XCTAssertEqual(WatchlistNameValidator.validate("  Movie Night \n"), .success("Movie Night"))
    }

    func testValidatorRejectsBlank() {
        XCTAssertEqual(WatchlistNameValidator.validate("  \n "), .failure(.blank))
    }

    func testValidatorLengthBoundary() {
        XCTAssertEqual(WatchlistNameValidator.validate(String(repeating: "a", count: 80)), .success(String(repeating: "a", count: 80)))
        XCTAssertEqual(WatchlistNameValidator.validate(String(repeating: "a", count: 81)), .failure(.tooLong))
    }

    // MARK: - APIClient

    func testCreateSendsPostAndDecodes() async throws {
        MockURLProtocol.requestHandler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/v1/watchlists")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            XCTAssertTrue(self.bodyString(request).contains("Movie Night"))
            return self.respond(request, status: 201, body: self.summaryJSON(name: "Movie Night"))
        }
        let created = try await makeClient().createSharedWatchlist(name: "Movie Night")
        XCTAssertEqual(created.name, "Movie Night")
        XCTAssertEqual(created.role, .owner)
    }

    func testRenameSendsPatch() async throws {
        MockURLProtocol.requestHandler = { request in
            XCTAssertEqual(request.httpMethod, "PATCH")
            XCTAssertEqual(request.url?.path, "/api/v1/watchlists/s1")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            return self.respond(request, status: 200, body: self.summaryJSON(name: "Renamed"))
        }
        let renamed = try await makeClient().renameSharedWatchlist(id: "s1", name: "Renamed")
        XCTAssertEqual(renamed.name, "Renamed")
    }

    // MARK: - View model

    func testBlankNameShowsErrorWithoutRequest() async {
        MockURLProtocol.requestHandler = { _ in
            XCTFail("No request expected for a blank name")
            throw URLError(.badURL)
        }
        let model = WatchlistNameEditorViewModel(mode: .create, initialName: "   ", apiClient: makeClient())
        let outcome = await model.submit()
        XCTAssertNil(outcome)
        XCTAssertEqual(model.errorMessage, WatchlistNameValidator.Failure.blank.message)
    }

    func testOverlongNameShowsErrorAndKeepsText() async {
        MockURLProtocol.requestHandler = { _ in
            XCTFail("No request expected for an overlong name")
            throw URLError(.badURL)
        }
        let long = String(repeating: "a", count: 81)
        let model = WatchlistNameEditorViewModel(mode: .rename(id: "s1"), initialName: long, apiClient: makeClient())
        let outcome = await model.submit()
        XCTAssertNil(outcome)
        XCTAssertEqual(model.errorMessage, WatchlistNameValidator.Failure.tooLong.message)
        XCTAssertEqual(model.name, long)
    }

    func testRenameSuccessReturnsSavedSummary() async {
        MockURLProtocol.requestHandler = { request in
            self.respond(request, status: 200, body: self.summaryJSON(name: "Renamed"))
        }
        let model = WatchlistNameEditorViewModel(mode: .rename(id: "s1"), initialName: " Renamed ", apiClient: makeClient())
        let outcome = await model.submit()
        guard case .saved(let saved) = outcome else { return XCTFail("Expected saved, got \(String(describing: outcome))") }
        XCTAssertEqual(saved.name, "Renamed")
        XCTAssertNil(model.errorMessage)
        XCTAssertFalse(model.isSaving)
    }

    func testRenameAfterAccessLossReportsAccessLost() async {
        MockURLProtocol.requestHandler = { request in
            self.respond(request, status: 404, body: #"{ "error": "Watchlist not found." }"#)
        }
        let model = WatchlistNameEditorViewModel(mode: .rename(id: "s1"), initialName: "New", apiClient: makeClient())
        let outcome = await model.submit()
        XCTAssertEqual(outcome, .accessLost)
    }

    func testServerValidationMessageIsShown() async {
        MockURLProtocol.requestHandler = { request in
            self.respond(request, status: 400, body: #"{ "error": "Shared watchlist names must be 80 characters or fewer." }"#)
        }
        let model = WatchlistNameEditorViewModel(mode: .create, initialName: "x", apiClient: makeClient())
        let outcome = await model.submit()
        XCTAssertNil(outcome)
        XCTAssertEqual(model.errorMessage, "Shared watchlist names must be 80 characters or fewer.")
    }

    func testTransportFailureIsRecoverable() async {
        MockURLProtocol.requestHandler = { _ in throw URLError(.notConnectedToInternet) }
        let model = WatchlistNameEditorViewModel(mode: .create, initialName: "Movie Night", apiClient: makeClient())
        let outcome = await model.submit()
        XCTAssertNil(outcome)
        XCTAssertNotNil(model.errorMessage)
        XCTAssertEqual(model.name, "Movie Night")
        XCTAssertTrue(model.canSubmit)
    }
}

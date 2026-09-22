import XCTest
@testable import Moviecal

@MainActor
final class CalendarSubscriptionViewModelTests: XCTestCase {
    private var baseURL: URL!

    override func setUp() {
        super.setUp()
        baseURL = URL(string: "https://api.moviecal.test")!
    }

    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        baseURL = nil
        super.tearDown()
    }

    private func makeClient() -> APIClient {
        APIClient(
            environment: APIEnvironment(baseURL: baseURL),
            tokenProvider: StubTokenProvider(),
            session: MockURLProtocol.makeSession()
        )
    }

    func testInitialStateIsIdle() {
        let viewModel = CalendarSubscriptionViewModel(apiClient: makeClient())
        XCTAssertEqual(viewModel.state, .idle)
    }

    func testLoadSuccessPopulatesLoadedState() async {
        let json = #"{ "subscriptionUrl": "https://moviecal.example/api/calendar/AbC123SecretToken" }"#
            .data(using: .utf8)!

        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, json)
        }

        let viewModel = CalendarSubscriptionViewModel(apiClient: makeClient())
        await viewModel.load()

        XCTAssertEqual(
            viewModel.state,
            .loaded(URL(string: "https://moviecal.example/api/calendar/AbC123SecretToken")!)
        )
    }

    func testLoadFailurePopulatesFailedStateWithMessage() async {
        MockURLProtocol.requestHandler = { _ in
            throw URLError(.notConnectedToInternet)
        }

        let viewModel = CalendarSubscriptionViewModel(apiClient: makeClient())
        await viewModel.load()

        guard case .failed(let message) = viewModel.state else {
            return XCTFail("Expected .failed, got \(viewModel.state)")
        }
        XCTAssertFalse(message.isEmpty)
    }

    func testRetryAfterFailureCanSucceed() async {
        var requestCount = 0
        MockURLProtocol.requestHandler = { request in
            requestCount += 1
            if requestCount == 1 {
                throw URLError(.notConnectedToInternet)
            }
            let json = #"{ "subscriptionUrl": "https://moviecal.example/api/calendar/AbC123SecretToken" }"#
                .data(using: .utf8)!
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, json)
        }

        let viewModel = CalendarSubscriptionViewModel(apiClient: makeClient())
        await viewModel.load()
        guard case .failed = viewModel.state else {
            return XCTFail("Expected first load to fail, got \(viewModel.state)")
        }

        await viewModel.load()
        XCTAssertEqual(
            viewModel.state,
            .loaded(URL(string: "https://moviecal.example/api/calendar/AbC123SecretToken")!)
        )
    }
}

private struct StubTokenProvider: AuthTokenProviding {
    func currentAccessToken() async throws -> String {
        "test-access-token"
    }
}

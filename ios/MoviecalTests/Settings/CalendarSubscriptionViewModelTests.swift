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
        let json = #"{ "subscriptionUrl": "https://calendar.example.test/" }"#
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
            .loaded(URL(string: "https://calendar.example.test/")!)
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

    func testRequestRotationRequiresLoadedState() async {
        let viewModel = CalendarSubscriptionViewModel(apiClient: makeClient())
        XCTAssertEqual(viewModel.state, .idle)

        viewModel.requestRotation()

        XCTAssertFalse(viewModel.isConfirmingRotation)
    }

    func testRequestRotationSetsConfirmingFlag() async {
        let json = #"{ "subscriptionUrl": "https://calendar.example.test/" }"#
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

        viewModel.requestRotation()

        XCTAssertTrue(viewModel.isConfirmingRotation)
    }

    func testCancelRotationClearsFlagWithoutCallingAPI() async {
        let loadJSON = #"{ "subscriptionUrl": "https://calendar.example.test/" }"#
            .data(using: .utf8)!
        var requestCount = 0
        MockURLProtocol.requestHandler = { request in
            requestCount += 1
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, loadJSON)
        }

        let viewModel = CalendarSubscriptionViewModel(apiClient: makeClient())
        await viewModel.load()
        XCTAssertEqual(requestCount, 1)

        viewModel.requestRotation()
        viewModel.cancelRotation()

        XCTAssertFalse(viewModel.isConfirmingRotation)
        XCTAssertEqual(requestCount, 1, "Cancelling must not issue a rotation request")
        XCTAssertEqual(
            viewModel.state,
            .loaded(URL(string: "https://calendar.example.test/")!)
        )
    }

    func testConfirmRotationSuccessUpdatesURLAndClearsConfirmation() async {
        var requestCount = 0
        MockURLProtocol.requestHandler = { request in
            requestCount += 1
            let json = requestCount == 1
                ? #"{ "subscriptionUrl": "https://calendar.example.test/old" }"#
                : #"{ "subscriptionUrl": "https://calendar.example.test/new" }"#
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, json.data(using: .utf8)!)
        }

        let viewModel = CalendarSubscriptionViewModel(apiClient: makeClient())
        await viewModel.load()
        viewModel.requestRotation()

        await viewModel.confirmRotation()

        XCTAssertFalse(viewModel.isConfirmingRotation)
        XCTAssertNil(viewModel.rotationErrorMessage)
        XCTAssertEqual(
            viewModel.state,
            .loaded(URL(string: "https://calendar.example.test/new")!)
        )
    }

    func testConfirmRotationFailureKeepsPreviousURLAndSetsError() async {
        var requestCount = 0
        MockURLProtocol.requestHandler = { request in
            requestCount += 1
            if requestCount == 1 {
                let json = #"{ "subscriptionUrl": "https://calendar.example.test/old" }"#
                    .data(using: .utf8)!
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"]
                )!
                return (response, json)
            }
            throw URLError(.notConnectedToInternet)
        }

        let viewModel = CalendarSubscriptionViewModel(apiClient: makeClient())
        await viewModel.load()
        viewModel.requestRotation()

        await viewModel.confirmRotation()

        XCTAssertFalse(viewModel.isConfirmingRotation)
        XCTAssertEqual(
            viewModel.state,
            .loaded(URL(string: "https://calendar.example.test/old")!),
            "A failed rotation must leave the previously displayed URL intact"
        )
        XCTAssertNotNil(viewModel.rotationErrorMessage)
    }

    func testDismissRotationErrorClearsMessage() async {
        var requestCount = 0
        MockURLProtocol.requestHandler = { request in
            requestCount += 1
            if requestCount == 1 {
                let json = #"{ "subscriptionUrl": "https://calendar.example.test/old" }"#
                    .data(using: .utf8)!
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"]
                )!
                return (response, json)
            }
            throw URLError(.notConnectedToInternet)
        }

        let viewModel = CalendarSubscriptionViewModel(apiClient: makeClient())
        await viewModel.load()
        viewModel.requestRotation()
        await viewModel.confirmRotation()
        XCTAssertNotNil(viewModel.rotationErrorMessage)

        viewModel.dismissRotationError()

        XCTAssertNil(viewModel.rotationErrorMessage)
    }

    func testRetryAfterFailureCanSucceed() async {
        var requestCount = 0
        MockURLProtocol.requestHandler = { request in
            requestCount += 1
            if requestCount == 1 {
                throw URLError(.notConnectedToInternet)
            }
            let json = #"{ "subscriptionUrl": "https://calendar.example.test/" }"#
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
            .loaded(URL(string: "https://calendar.example.test/")!)
        )
    }
}

private struct StubTokenProvider: AuthTokenProviding {
    func currentAccessToken() async throws -> String {
        "test-access-token"
    }
}

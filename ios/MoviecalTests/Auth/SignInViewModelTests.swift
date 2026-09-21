import XCTest
@testable import Moviecal

@MainActor
final class SignInViewModelTests: XCTestCase {
    private var mockClient: MockSupabaseAuthClient!
    private var authStore: AuthStore!
    private var viewModel: SignInViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockSupabaseAuthClient()
        authStore = AuthStore(authClient: mockClient)
        viewModel = SignInViewModel(authStore: authStore)
    }

    override func tearDown() {
        viewModel = nil
        authStore = nil
        mockClient = nil
        super.tearDown()
    }

    func testCannotSubmitWithEmptyFields() {
        XCTAssertFalse(viewModel.canSubmit)

        viewModel.email = "person@example.com"
        XCTAssertFalse(viewModel.canSubmit, "a password is still required")

        viewModel.password = "correct horse battery staple"
        XCTAssertTrue(viewModel.canSubmit)
    }

    func testSuccessfulSignInClearsErrorAndCallsAuthStore() async {
        let session = MockSupabaseAuthClient.makeSession(email: "person@example.com")
        mockClient.signInResult = .success(session)
        viewModel.email = "person@example.com"
        viewModel.password = "correct horse battery staple"

        await viewModel.signIn()

        XCTAssertEqual(mockClient.signInCallCount, 1)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertFalse(viewModel.isSubmitting)
    }

    func testFailedSignInSetsErrorMessageAndResetsSubmitting() async {
        struct InvalidCredentials: Error {}
        mockClient.signInResult = .failure(InvalidCredentials())
        viewModel.email = "person@example.com"
        viewModel.password = "wrong-password"

        await viewModel.signIn()

        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertFalse(viewModel.isSubmitting)
    }
}

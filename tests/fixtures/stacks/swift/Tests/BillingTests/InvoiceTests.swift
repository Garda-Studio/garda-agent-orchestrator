import XCTest
@testable import Billing
final class InvoiceTests: XCTestCase { func testTotal() { XCTAssertEqual(total(1, 2), 3) } }

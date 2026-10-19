RSpec.describe Billing do
  it("totals") { expect(Billing.total(1, 2)).to eq(3) }
end

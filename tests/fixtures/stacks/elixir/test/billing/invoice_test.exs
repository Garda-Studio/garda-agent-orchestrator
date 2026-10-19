defmodule Billing.InvoiceTest do
  use ExUnit.Case
  test "total", do: assert Billing.Invoice.total(1, 2) == 3
end

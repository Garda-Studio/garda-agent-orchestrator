from billing.invoice import total


def test_total():
    assert total(1, 2) == 3

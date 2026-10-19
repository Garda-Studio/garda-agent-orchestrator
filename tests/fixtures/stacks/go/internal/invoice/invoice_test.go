package invoice

import "testing"

func TestTotal(t *testing.T) { if Total(1, 2) != 3 { t.Fatal("total") } }

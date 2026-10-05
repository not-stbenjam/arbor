package main

import (
	"image"
	"image/color"
	"os"
	"strconv"
	"strings"
	"testing"
)

func projectDrawing(t *testing.T) drawing {
	t.Helper()
	source, err := os.ReadFile("../../desktop/common/icon.svg")
	if err != nil {
		t.Fatal(err)
	}
	art, err := parse(source)
	if err != nil {
		t.Fatal(err)
	}
	return art
}

// The application icon is the README's drawing: the same ground, stem and
// leaves, in the same colours and places, at every size it is drawn.
func TestIconIsTheProjectDrawingAtEverySize(t *testing.T) {
	art := projectDrawing(t)
	if art.size != 64 || len(art.shapes) != 6 {
		t.Fatalf("expected the ground, the stem and four leaves in a 64-unit square: %v units, %d shapes", art.size, len(art.shapes))
	}
	ground, stem, leaf := color.NRGBA{0x1e, 0x46, 0x38, 255}, color.NRGBA{0xf5, 0xf4, 0xe9, 255}, color.NRGBA{0xd5, 0xeb, 0x9d, 255}
	for _, size := range []int{32, 64, 256, 1024} {
		img := art.draw(size).(*image.NRGBA)
		// A point of the drawing, in its own units, as a pixel of this size.
		at := func(x, y float64) color.NRGBA {
			scale := (canvas - 2*inset) / art.size
			return img.NRGBAAt(int((inset+x*scale)/canvas*float64(size)), int((inset+y*scale)/canvas*float64(size)))
		}
		for _, check := range []struct {
			what string
			x, y float64
			want color.NRGBA
		}{
			{"the ground", 10, 54, ground},
			{"the ground beside the stem", 50, 52, ground},
			{"the lower left leaf", 22, 31, leaf},
			{"the upper right leaf", 43, 23, leaf},
			{"the upper left leaf", 25, 19, leaf},
			{"the lower right leaf", 42, 37, leaf},
		} {
			if got := at(check.x, check.y); got != check.want {
				t.Errorf("%d px: %s is %v, want %v", size, check.what, got, check.want)
			}
		}
		// The stem is four units wide: a whole pixel of it only from 64 px
		// up, and at 32 px still plainly paler than the ground beside it.
		if foot := at(32, 47); size >= 64 && foot != stem || foot.R < 150 || foot.A != 255 {
			t.Errorf("%d px: the foot of the stem is %v, want %v", size, foot, stem)
		}
		if corner := img.NRGBAAt(0, 0); corner.A != 0 {
			t.Errorf("%d px: the corner of the canvas is not clear: %v", size, corner)
		}
		// The drawing's own rounded corner is clear of the ground as well.
		if rounded := at(1.5, 1.5); rounded.R == ground.R && rounded.A == 255 {
			t.Errorf("%d px: the ground's corner is not rounded: %v", size, rounded)
		}
	}
}

// What the drawing may contain is small on purpose. Something outside it
// stops the build rather than being left out or drawn wrong.
func TestUnsupportedDrawingsAreRefused(t *testing.T) {
	svg := func(body string) []byte {
		return []byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` + body + `</svg>`)
	}
	for name, source := range map[string][]byte{
		"a circle":            svg(`<circle cx="3" cy="3" r="2" fill="#000000"/>`),
		"an arc in a path":    svg(`<path d="M1 1A2 2 0 0 1 5 5" fill="#000000"/>`),
		"a square-ended line": svg(`<path d="M1 1H9" stroke="#000000" stroke-width="2" fill="none"/>`),
		"a named colour":      svg(`<rect width="64" height="64" fill="green"/>`),
		"an unfinished curve": svg(`<path d="M1 1C2 2 3 3" fill="#000000"/>`),
		"nothing at all":      svg(``),
		"an oblong":           []byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><rect width="64" height="32" fill="#000000"/></svg>`),
	} {
		if _, err := parse(source); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}

func TestPathDataIsReadAsSVGWritesIt(t *testing.T) {
	// Numbers run together where a sign makes the boundary plain, a command
	// repeats until another is given, and lower case is relative.
	runs, err := outline("M10 10l5-5 5 5H0V0zM1.5.5L2,3")
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, run := range runs {
		var points []string
		for _, p := range run {
			points = append(points, strings.TrimRight(strings.TrimRight(strconvFormat(p.x), "0"), ".")+","+strings.TrimRight(strings.TrimRight(strconvFormat(p.y), "0"), "."))
		}
		got = append(got, strings.Join(points, " "))
	}
	want := []string{"10,10 15,5 20,10 0,10 0,0", "1.5,0.5 2,3"}
	if strings.Join(got, " | ") != strings.Join(want, " | ") {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func strconvFormat(v float64) string { return strconv.FormatFloat(v, 'f', 3, 64) }

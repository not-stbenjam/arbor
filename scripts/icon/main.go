// Command icon builds the application icons from the project's one drawing,
// desktop/common/icon.svg, without platform-specific tooling.
//
// The README shows that file directly. Drawing the application icon from the
// same file, rather than from a second description of it, is what keeps the
// two from drifting apart. Only the small part of SVG the drawing uses is
// understood, and anything else stops the build instead of being drawn wrong.
package main

import (
	"bytes"
	"encoding/binary"
	"encoding/xml"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func main() {
	if len(os.Args) != 3 {
		panic("usage: go run ./scripts/icon DRAWING.svg OUTPUT_DIRECTORY")
	}
	source, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	art, err := parse(source)
	if err != nil {
		panic(fmt.Errorf("%s: %w", os.Args[1], err))
	}
	var chunks bytes.Buffer
	for _, entry := range []struct {
		size int
		kind string
	}{{32, "ic11"}, {64, "ic12"}, {128, "ic07"}, {256, "ic08"}, {512, "ic09"}, {1024, "ic10"}} {
		var encoded bytes.Buffer
		if err := png.Encode(&encoded, art.draw(entry.size)); err != nil {
			panic(err)
		}
		if entry.size == 512 {
			if err := os.WriteFile(filepath.Join(os.Args[2], "icon.png"), encoded.Bytes(), 0644); err != nil {
				panic(err)
			}
		}
		chunks.WriteString(entry.kind)
		if err := binary.Write(&chunks, binary.BigEndian, uint32(encoded.Len()+8)); err != nil {
			panic(err)
		}
		chunks.Write(encoded.Bytes())
	}
	var icon bytes.Buffer
	icon.WriteString("icns")
	if err := binary.Write(&icon, binary.BigEndian, uint32(chunks.Len()+8)); err != nil {
		panic(err)
	}
	icon.Write(chunks.Bytes())
	if err := os.WriteFile(filepath.Join(os.Args[2], "Arbor.icns"), icon.Bytes(), 0644); err != nil {
		panic(err)
	}
}

// An application icon leaves a margin around its artwork, as the icons beside
// it in a dock do, and casts a faint shadow into that margin.
const (
	canvas = 1024.0
	inset  = 100.0
)

type point struct{ x, y float64 }

// A shape is one element of the drawing: how far a point is from its edge,
// negative inside, and the colour it is filled with.
type shape struct {
	distance  func(point) float64
	colour    [3]float64
	low, high point // the box the shape fits in
}

type drawing struct {
	size   float64 // the drawing is square, this many of its own units a side
	shapes []shape
}

// draw paints the drawing at one size. Every size is painted from the shapes
// themselves, so each has its own clean edges rather than a scaled copy's.
func (d drawing) draw(size int) image.Image {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	// One pixel, in the drawing's units.
	pixel := canvas / float64(size) * d.size / (canvas - 2*inset)
	// An edge fades across one sample, which is enough alone at large sizes.
	// Small sizes, where a pixel spans a good part of a leaf, average several.
	grid := 1
	if size < 256 {
		grid = 4
	}
	width := pixel / float64(grid)
	origin := inset / (canvas - 2*inset) * d.size
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var sum paint
			for j := 0; j < grid; j++ {
				for i := 0; i < grid; i++ {
					sum = sum.plus(d.sample(point{
						(float64(x)+(float64(i)+.5)/float64(grid))*pixel - origin,
						(float64(y)+(float64(j)+.5)/float64(grid))*pixel - origin,
					}, width))
				}
			}
			if sum.a <= 0 {
				continue
			}
			n := float64(grid * grid)
			img.SetNRGBA(x, y, color.NRGBA{
				channel(sum.r / sum.a),
				channel(sum.g / sum.a),
				channel(sum.b / sum.a),
				channel(sum.a / n),
			})
		}
	}
	return img
}

// sample paints one point, given how far apart samples are.
func (d drawing) sample(p point, width float64) paint {
	var out paint
	if len(d.shapes) == 0 {
		return out
	}
	// The first shape is the ground everything else sits on. Its shadow is
	// the only thing here that is not in the drawing.
	ground := d.shapes[0]
	soft := d.size * .035
	out = out.over([3]float64{}, .24*(1-smooth(-soft, soft, ground.distance(point{p.x, p.y - d.size*.016}))))
	for _, s := range d.shapes {
		if p.x < s.low.x-width || p.x > s.high.x+width || p.y < s.low.y-width || p.y > s.high.y+width {
			continue
		}
		if covered := clamp(.5-s.distance(p)/width, 0, 1); covered > 0 {
			out = out.over(s.colour, covered)
		}
	}
	return out
}

// parse reads the drawing. It accepts a square viewBox holding rectangles
// with rounded corners and paths that are either filled or stroked with round
// ends, which is all the drawing is made of.
func parse(source []byte) (drawing, error) {
	var svg struct {
		ViewBox  string `xml:"viewBox,attr"`
		Elements []struct {
			XMLName xml.Name
			Width   string `xml:"width,attr"`
			Height  string `xml:"height,attr"`
			X       string `xml:"x,attr"`
			Y       string `xml:"y,attr"`
			Radius  string `xml:"rx,attr"`
			Path    string `xml:"d,attr"`
			Fill    string `xml:"fill,attr"`
			Stroke  string `xml:"stroke,attr"`
			Weight  string `xml:"stroke-width,attr"`
			Cap     string `xml:"stroke-linecap,attr"`
		} `xml:",any"`
	}
	if err := xml.Unmarshal(source, &svg); err != nil {
		return drawing{}, err
	}
	box := strings.Fields(svg.ViewBox)
	if len(box) != 4 || box[0] != "0" || box[1] != "0" || box[2] != box[3] {
		return drawing{}, fmt.Errorf("the viewBox must be a square at the origin, not %q", svg.ViewBox)
	}
	var d drawing
	d.size = number(box[2])
	for _, e := range svg.Elements {
		switch e.XMLName.Local {
		case "rect":
			colour, err := hex(e.Fill)
			if err != nil {
				return d, err
			}
			low := point{number(e.X), number(e.Y)}
			high := point{low.x + number(e.Width), low.y + number(e.Height)}
			radius := number(e.Radius)
			d.shapes = append(d.shapes, shape{
				distance: func(p point) float64 { return rounded(p, low, high, radius) },
				colour:   colour, low: low, high: high,
			})
		case "path":
			runs, err := outline(e.Path)
			if err != nil {
				return d, err
			}
			if e.Stroke != "" {
				if e.Cap != "round" || (e.Fill != "" && e.Fill != "none") {
					return d, fmt.Errorf("a stroked path must have round ends and no fill: %q", e.Path)
				}
				colour, err := hex(e.Stroke)
				if err != nil {
					return d, err
				}
				half := number(e.Weight) / 2
				low, high := bounds(runs, half)
				d.shapes = append(d.shapes, shape{
					distance: func(p point) float64 { return nearest(p, runs, false) - half },
					colour:   colour, low: low, high: high,
				})
				continue
			}
			colour, err := hex(e.Fill)
			if err != nil {
				return d, err
			}
			// Each part of a filled path is its own closed outline.
			for _, run := range runs {
				run := [][]point{run}
				low, high := bounds(run, 0)
				d.shapes = append(d.shapes, shape{
					distance: func(p point) float64 {
						if inside(p, run[0]) {
							return -nearest(p, run, true)
						}
						return nearest(p, run, true)
					},
					colour: colour, low: low, high: high,
				})
			}
		default:
			return d, fmt.Errorf("the drawing uses <%s>, which this cannot draw", e.XMLName.Local)
		}
	}
	if len(d.shapes) == 0 {
		return d, fmt.Errorf("the drawing is empty")
	}
	return d, nil
}

// outline turns path data into runs of points, one run per "move to". Curves
// become short straight steps. It knows moves, lines and cubic curves, in
// absolute and relative form, and closing a run.
func outline(data string) ([][]point, error) {
	tokens := tokenize(data)
	var runs [][]point
	var at, start point
	command := byte(0)
	next := func() (float64, error) {
		if len(tokens) == 0 || isCommand(tokens[0]) {
			return 0, fmt.Errorf("path data ends in the middle of %q", string(command))
		}
		v, err := strconv.ParseFloat(tokens[0], 64)
		tokens = tokens[1:]
		return v, err
	}
	for len(tokens) > 0 {
		if isCommand(tokens[0]) {
			command = tokens[0][0]
			tokens = tokens[1:]
			if command == 'Z' || command == 'z' {
				at = start
				continue
			}
		}
		relative := command >= 'a'
		read := func(count int) ([]float64, error) {
			values := make([]float64, count)
			for i := range values {
				v, err := next()
				if err != nil {
					return nil, err
				}
				values[i] = v
			}
			return values, nil
		}
		to := func(x, y float64) point {
			if relative {
				return point{at.x + x, at.y + y}
			}
			return point{x, y}
		}
		switch command {
		case 'M', 'm':
			v, err := read(2)
			if err != nil {
				return nil, err
			}
			at = to(v[0], v[1])
			start = at
			runs = append(runs, []point{at})
			// Further pairs after a move are lines.
			command = map[byte]byte{'M': 'L', 'm': 'l'}[command]
			continue
		case 'L', 'l':
			v, err := read(2)
			if err != nil {
				return nil, err
			}
			at = to(v[0], v[1])
		case 'H', 'h':
			v, err := read(1)
			if err != nil {
				return nil, err
			}
			if relative {
				at.x += v[0]
			} else {
				at.x = v[0]
			}
		case 'V', 'v':
			v, err := read(1)
			if err != nil {
				return nil, err
			}
			if relative {
				at.y += v[0]
			} else {
				at.y = v[0]
			}
		case 'C', 'c':
			v, err := read(6)
			if err != nil {
				return nil, err
			}
			a, b, end := to(v[0], v[1]), to(v[2], v[3]), to(v[4], v[5])
			const steps = 24
			for i := 1; i < steps; i++ {
				t := float64(i) / steps
				u := 1 - t
				runs[len(runs)-1] = append(runs[len(runs)-1], point{
					u*u*u*at.x + 3*u*u*t*a.x + 3*u*t*t*b.x + t*t*t*end.x,
					u*u*u*at.y + 3*u*u*t*a.y + 3*u*t*t*b.y + t*t*t*end.y,
				})
			}
			at = end
		default:
			return nil, fmt.Errorf("path data uses %q, which this cannot draw", string(command))
		}
		if len(runs) == 0 {
			return nil, fmt.Errorf("path data must begin with a move")
		}
		runs[len(runs)-1] = append(runs[len(runs)-1], at)
	}
	return runs, nil
}

func isCommand(token string) bool {
	return len(token) == 1 && (token[0] >= 'A' && token[0] <= 'Z' || token[0] >= 'a' && token[0] <= 'z')
}

// tokenize splits path data into command letters and numbers. A number ends
// where a sign or a letter begins, with or without a space or comma between.
func tokenize(data string) []string {
	var tokens []string
	current := ""
	flush := func() {
		if current != "" {
			tokens = append(tokens, current)
			current = ""
		}
	}
	for i := 0; i < len(data); i++ {
		c := data[i]
		switch {
		case c == ' ' || c == ',' || c == '\n' || c == '\t' || c == '\r':
			flush()
		case c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z':
			flush()
			tokens = append(tokens, string(c))
		case c == '-' || c == '+':
			flush()
			current = string(c)
		case c == '.' && strings.Contains(current, "."):
			flush()
			current = "."
		default:
			current += string(c)
		}
	}
	flush()
	return tokens
}

// nearest is the distance from p to the nearest of the runs' lines. A closed
// run also has a line from its last point back to its first.
func nearest(p point, runs [][]point, closed bool) float64 {
	d := math.Inf(1)
	for _, run := range runs {
		for i := 1; i < len(run); i++ {
			d = math.Min(d, segment(p, run[i-1], run[i]))
		}
		if closed && len(run) > 1 {
			d = math.Min(d, segment(p, run[len(run)-1], run[0]))
		}
		if len(run) == 1 {
			d = math.Min(d, math.Hypot(p.x-run[0].x, p.y-run[0].y))
		}
	}
	return d
}

// inside reports whether p is within a closed run, by how many times the
// run winds around it.
func inside(p point, run []point) bool {
	winding := 0
	for i := range run {
		a, b := run[i], run[(i+1)%len(run)]
		side := (b.x-a.x)*(p.y-a.y) - (p.x-a.x)*(b.y-a.y)
		if a.y <= p.y && b.y > p.y && side > 0 {
			winding++
		} else if a.y > p.y && b.y <= p.y && side < 0 {
			winding--
		}
	}
	return winding != 0
}

func bounds(runs [][]point, margin float64) (low, high point) {
	low, high = point{math.Inf(1), math.Inf(1)}, point{math.Inf(-1), math.Inf(-1)}
	for _, run := range runs {
		for _, p := range run {
			low = point{math.Min(low.x, p.x), math.Min(low.y, p.y)}
			high = point{math.Max(high.x, p.x), math.Max(high.y, p.y)}
		}
	}
	return point{low.x - margin, low.y - margin}, point{high.x + margin, high.y + margin}
}

// rounded is the distance to a rectangle whose corners are quarter circles.
func rounded(p, low, high point, radius float64) float64 {
	centre := point{(low.x + high.x) / 2, (low.y + high.y) / 2}
	x := math.Abs(p.x-centre.x) - ((high.x-low.x)/2 - radius)
	y := math.Abs(p.y-centre.y) - ((high.y-low.y)/2 - radius)
	return math.Hypot(math.Max(x, 0), math.Max(y, 0)) + math.Min(math.Max(x, y), 0) - radius
}

func segment(p, a, b point) float64 {
	dx, dy := b.x-a.x, b.y-a.y
	length := dx*dx + dy*dy
	if length == 0 {
		return math.Hypot(p.x-a.x, p.y-a.y)
	}
	t := clamp(((p.x-a.x)*dx+(p.y-a.y)*dy)/length, 0, 1)
	return math.Hypot(p.x-(a.x+t*dx), p.y-(a.y+t*dy))
}

// paint is a colour with its opacity already multiplied in.
type paint struct{ r, g, b, a float64 }

func (p paint) plus(q paint) paint { return paint{p.r + q.r, p.g + q.g, p.b + q.b, p.a + q.a} }

// over lays a colour of the given opacity on top of p.
func (p paint) over(c [3]float64, alpha float64) paint {
	return paint{
		c[0]*alpha + p.r*(1-alpha),
		c[1]*alpha + p.g*(1-alpha),
		c[2]*alpha + p.b*(1-alpha),
		alpha + p.a*(1-alpha),
	}
}

func channel(v float64) uint8 { return uint8(math.Round(clamp(v, 0, 1) * 255)) }

func smooth(from, to, v float64) float64 {
	t := clamp((v-from)/(to-from), 0, 1)
	return t * t * (3 - 2*t)
}

func clamp(v, low, high float64) float64 { return math.Max(low, math.Min(high, v)) }

// number reads an attribute that may be absent, which SVG takes as zero.
func number(text string) float64 {
	v, _ := strconv.ParseFloat(strings.TrimSpace(text), 64)
	return v
}

func hex(text string) ([3]float64, error) {
	if len(text) != 7 || text[0] != '#' {
		return [3]float64{}, fmt.Errorf("a colour must be written #rrggbb, not %q", text)
	}
	v, err := strconv.ParseUint(text[1:], 16, 32)
	if err != nil {
		return [3]float64{}, fmt.Errorf("a colour must be written #rrggbb, not %q", text)
	}
	return [3]float64{float64(v>>16&255) / 255, float64(v>>8&255) / 255, float64(v&255) / 255}, nil
}

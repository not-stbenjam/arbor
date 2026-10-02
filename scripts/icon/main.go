// Command icon builds a native macOS icon without platform-specific tooling.
package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
)

func main() {
	if len(os.Args) != 2 {
		panic("usage: go run ./scripts/icon OUTPUT_DIRECTORY")
	}
	var chunks bytes.Buffer
	for _, entry := range []struct {
		size int
		kind string
	}{{128, "ic07"}, {256, "ic08"}, {512, "ic09"}, {1024, "ic10"}} {
		var encoded bytes.Buffer
		if err := png.Encode(&encoded, drawIcon(entry.size)); err != nil {
			panic(err)
		}
		if entry.size == 512 {
			if err := os.WriteFile(filepath.Join(os.Args[1], "icon.png"), encoded.Bytes(), 0644); err != nil {
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
	if err := os.WriteFile(filepath.Join(os.Args[1], "Arbor.icns"), icon.Bytes(), 0644); err != nil {
		panic(err)
	}
}

func drawIcon(size int) image.Image {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	forest := color.NRGBA{0x1e, 0x46, 0x38, 255}
	cream := color.NRGBA{0xf4, 0xf3, 0xe9, 255}
	lime := color.NRGBA{0xd5, 0xeb, 0x9d, 255}
	// Four samples per pixel keep the smaller icon sizes smooth.
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var r, g, b, a uint32
			for _, offset := range [][2]float64{{.25, .25}, {.75, .25}, {.25, .75}, {.75, .75}} {
				px := (float64(x) + offset[0]) * 64 / float64(size)
				py := (float64(y) + offset[1]) * 64 / float64(size)
				c := color.NRGBA{}
				dx := math.Max(math.Abs(px-32)-18, 0)
				dy := math.Max(math.Abs(py-32)-18, 0)
				if dx*dx+dy*dy <= 100 {
					c = forest
					if distance(px, py, 32, 18, 32, 49) < 1.8 {
						c = cream
					}
					if distance(px, py, 32, 28, 23, 19) < 2.5 ||
						distance(px, py, 32, 36, 43, 25) < 2.5 ||
						distance(px, py, 32, 43, 21, 32) < 2.5 {
						c = lime
					}
				}
				r += uint32(c.R) * uint32(c.A)
				g += uint32(c.G) * uint32(c.A)
				b += uint32(c.B) * uint32(c.A)
				a += uint32(c.A)
			}
			if a != 0 {
				img.SetNRGBA(x, y, color.NRGBA{uint8(r / a), uint8(g / a), uint8(b / a), uint8(a / 4)})
			}
		}
	}
	return img
}

func distance(x, y, x1, y1, x2, y2 float64) float64 {
	dx, dy := x2-x1, y2-y1
	t := math.Max(0, math.Min(1, ((x-x1)*dx+(y-y1)*dy)/(dx*dx+dy*dy)))
	return math.Hypot(x-(x1+t*dx), y-(y1+t*dy))
}

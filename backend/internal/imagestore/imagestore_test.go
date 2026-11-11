package imagestore

import "testing"

func TestDetectType(t *testing.T) {
	cases := map[string]struct {
		data []byte
		want string
	}{
		"jpeg": {[]byte("\xFF\xD8\xFF\xE0\x00\x10JFIF\x00"), "image/jpeg"},
		"png":  {[]byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"), "image/png"},
		"gif":  {[]byte("GIF89a\x01\x00\x01\x00"), "image/gif"},
		"webp": {[]byte("RIFF\x00\x00\x00\x00WEBPVP8 "), "image/webp"},
		"html": {[]byte("<html><script>alert(1)</script>"), ""},
		"svg":  {[]byte(`<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>`), ""},
		"text": {[]byte("hello"), ""},
	}
	for name, c := range cases {
		if got := DetectType(c.data); got != c.want {
			t.Errorf("%s: got %q, want %q", name, got, c.want)
		}
	}
}

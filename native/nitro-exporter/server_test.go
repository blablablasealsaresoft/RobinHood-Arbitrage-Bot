//go:build linux

package nativebridge

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func serverFixture(t *testing.T) (*Server, *Manifest, *memoryState, *net.UnixConn, *bufio.Reader) {
	t.Helper()
	dir, e := os.MkdirTemp("", "native-export-")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	c := configuration("v2")
	c.SocketPath = filepath.Join(dir, "s")
	m := manifest(t, c)
	s, e := Listen(m)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(s.Close)
	conn, e := net.DialUnix("unix", nil, &net.UnixAddr{Name: c.SocketPath, Net: "unix"})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = conn.Close() })
	deadline := time.Now().Add(time.Second)
	for {
		s.mutex.Lock()
		n := len(s.peers)
		s.mutex.Unlock()
		if n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("peer not accepted")
		}
		time.Sleep(time.Millisecond)
	}
	return s, m, stateFor(m), conn, bufio.NewReader(conn)
}
func readObject(t *testing.T, c *net.UnixConn, r *bufio.Reader) map[string]any {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(time.Second))
	b, e := r.ReadBytes('\n')
	if e != nil {
		t.Fatal(e)
	}
	var f map[string]any
	if e = json.Unmarshal(b, &f); e != nil {
		t.Fatal(e)
	}
	return f
}
func TestSocketSnapshotBlockReceiptOrdering(t *testing.T) {
	s, _, state, c, r := serverFixture(t)
	if e := s.Commit(head(10), state, []Receipt{validReceipt()}); e != nil {
		t.Fatal(e)
	}
	if f := readObject(t, c, r); f["type"] != "snapshot" {
		t.Fatal(f)
	}
	receipt := validReceipt()
	receipt.BlockNumber = "11"
	receipt.BlockHash = head(11).Hash.String()
	if e := s.Commit(head(11), state, []Receipt{receipt}); e != nil {
		t.Fatal(e)
	}
	if f := readObject(t, c, r); f["type"] != "block" {
		t.Fatal("historical receipt leaked or wrong order", f)
	}
	if f := readObject(t, c, r); f["type"] != "receipt" {
		t.Fatal(f)
	}
}
func TestReorgInvalidationThenSnapshot(t *testing.T) {
	s, _, state, c, r := serverFixture(t)
	_ = s.Commit(head(10), state, nil)
	_ = readObject(t, c, r)
	s.Invalidate(10, "test reorg")
	if f := readObject(t, c, r); f["type"] != "invalidate" || f["fromBlock"] != "10" {
		t.Fatal(f)
	}
	h := head(10)
	h.Hash = word(44)
	_ = s.Commit(h, state, nil)
	if f := readObject(t, c, r); f["type"] != "snapshot" || f["blockHash"] != h.Hash.String() {
		t.Fatal(f)
	}
	h2 := head(11)
	h2.ParentHash = h.Hash
	_ = s.Commit(h2, state, nil)
	if f := readObject(t, c, r); f["type"] != "block" {
		t.Fatal(f)
	}
}
func TestGapInvalidatesRatherThanSkipping(t *testing.T) {
	s, _, state, c, r := serverFixture(t)
	_ = s.Commit(head(10), state, nil)
	_ = readObject(t, c, r)
	_ = s.Commit(head(12), state, nil)
	if f := readObject(t, c, r); f["type"] != "invalidate" || f["fromBlock"] != "11" {
		t.Fatal(f)
	}
	if f := readObject(t, c, r); f["type"] != "snapshot" {
		t.Fatal(f)
	}
}
func TestBadCaptureDisconnectsWithoutPartialFrame(t *testing.T) {
	s, _, state, c, r := serverFixture(t)
	_ = s.Commit(head(10), state, nil)
	_ = readObject(t, c, r)
	state.fail = true
	if e := s.Commit(head(11), state, nil); e == nil {
		t.Fatal("read error ignored")
	}
	_ = c.SetReadDeadline(time.Now().Add(time.Second))
	if b, e := r.ReadBytes('\n'); e == nil || len(b) > 0 {
		t.Fatal("partial state was exported")
	}
}
func TestOverflowClosesPeer(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	// Exercise bounded enqueue without a running writer, so overflow is deterministic.
	_, _, _, conn, _ := serverFixture(t)
	p := &peer{conn: conn, queue: make(chan delivery, 1), stopped: make(chan struct{})}
	s := &Server{}
	s.enqueue(p, delivery{})
	s.enqueue(p, delivery{})
	select {
	case <-p.stopped:
	default:
		t.Fatal("overflow did not close peer")
	}
}
func TestSocketPermissionsAndExistingPath(t *testing.T) {
	s, m, _, _, _ := serverFixture(t)
	info, e := os.Stat(m.SocketPath())
	if e != nil {
		t.Fatal(e)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatal(info.Mode())
	}
	if _, e = Listen(m); e == nil {
		t.Fatal("existing socket overwritten")
	}
	s.Close()
	dir := filepath.Dir(m.SocketPath())
	if e = os.Chmod(dir, 0755); e != nil {
		t.Fatal(e)
	}
	if _, e = Listen(m); e == nil {
		t.Fatal("world-readable parent accepted")
	}
}
func TestManifestFileOwnershipAndMode(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "manifest.json")
	raw, _ := json.Marshal(configuration("v2"))
	if e := os.WriteFile(p, raw, 0644); e != nil {
		t.Fatal(e)
	}
	if _, e := LoadManifestFile(p); e == nil {
		t.Fatal("0644 accepted")
	}
	_ = os.Chmod(p, 0600)
	if _, e := LoadManifestFile(p); e != nil {
		t.Fatal(e)
	}
	link := filepath.Join(dir, "link")
	_ = os.Symlink(p, link)
	if _, e := LoadManifestFile(link); e == nil {
		t.Fatal("symlink accepted")
	}
}

func TestSlowConsumerWriteDeadlineDisconnects(t *testing.T) {
	s, _, _, _, _ := serverFixture(t)
	s.mutex.Lock()
	s.timeout = 20 * time.Millisecond
	var p *peer
	for candidate := range s.peers {
		p = candidate
		break
	}
	if e := p.conn.SetWriteBuffer(4096); e != nil {
		s.mutex.Unlock()
		t.Fatal(e)
	}
	s.enqueue(p, delivery{[][]byte{make([]byte, 900000)}})
	s.mutex.Unlock()
	select {
	case <-p.stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("slow reader kept blocked writer alive")
	}
}

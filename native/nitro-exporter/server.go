//go:build linux

package nativebridge

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"
)

type delivery struct{ lines [][]byte }
type peer struct {
	conn    *net.UnixConn
	queue   chan delivery
	stopped chan struct{}
	once    sync.Once
	primed  bool
}

func (p *peer) stop() { p.once.Do(func() { close(p.stopped); _ = p.conn.Close() }) }

type Server struct {
	manifest *Manifest
	listener *net.UnixListener
	mutex    sync.Mutex
	peers    map[*peer]struct{}
	last     *Head
	closed   bool
	timeout  time.Duration
	capacity int
}

// Only a pre-existing, non-symlink 0700 directory owned by this UID is accepted.
// Existing socket paths are NEVER unlinked automatically: they may belong to
// another running producer. Explicit operator recovery is required after a crash.
func secureParent(socketPath string) error {
	if !filepath.IsAbs(socketPath) || filepath.Clean(socketPath) != socketPath || len(socketPath) > 100 {
		return errors.New("absolute clean short socket path required")
	}
	dir := filepath.Dir(socketPath)
	resolved, e := filepath.EvalSymlinks(dir)
	if e != nil || resolved != dir {
		return errors.New("socket directory must not contain symlinks")
	}
	info, e := os.Lstat(dir)
	if e != nil {
		return e
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode().Perm() != 0700 || stat.Uid != uint32(os.Geteuid()) {
		return errors.New("socket directory must be owned 0700")
	}
	if _, e := os.Lstat(socketPath); !os.IsNotExist(e) {
		return errors.New("socket path already exists or cannot be inspected")
	}
	return nil
}
func LoadManifestFile(file string) (*Manifest, error) {
	info, e := os.Lstat(file)
	if e != nil {
		return nil, e
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || stat.Uid != uint32(os.Geteuid()) || info.Size() > MaxFrameBytes {
		return nil, errors.New("manifest must be owned regular 0600 file")
	}
	raw, e := os.ReadFile(file)
	if e != nil {
		return nil, e
	}
	return LoadManifest(raw)
}
func Listen(m *Manifest) (*Server, error) { return listen(m, 8, 250*time.Millisecond) }
func listen(m *Manifest, capacity int, timeout time.Duration) (*Server, error) {
	if m == nil || capacity < 1 || capacity > 64 || timeout <= 0 {
		return nil, errors.New("invalid server configuration")
	}
	if e := secureParent(m.SocketPath()); e != nil {
		return nil, e
	}
	l, e := net.ListenUnix("unix", &net.UnixAddr{Name: m.SocketPath(), Net: "unix"})
	if e != nil {
		return nil, e
	}
	if e = os.Chmod(m.SocketPath(), 0600); e != nil {
		_ = l.Close()
		return nil, e
	}
	s := &Server{manifest: m, listener: l, peers: map[*peer]struct{}{}, capacity: capacity, timeout: timeout}
	go s.accept()
	return s, nil
}
func sameUID(c *net.UnixConn) bool {
	raw, e := c.SyscallConn()
	if e != nil {
		return false
	}
	valid := false
	if e = raw.Control(func(fd uintptr) {
		u, e := syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
		valid = e == nil && u.Uid == uint32(os.Geteuid())
	}); e != nil {
		return false
	}
	return valid
}
func (s *Server) accept() {
	for {
		c, e := s.listener.AcceptUnix()
		if e != nil {
			return
		}
		if !sameUID(c) {
			_ = c.Close()
			continue
		}
		p := &peer{conn: c, queue: make(chan delivery, s.capacity), stopped: make(chan struct{})}
		s.mutex.Lock()
		if s.closed || len(s.peers) >= 4 {
			s.mutex.Unlock()
			p.stop()
			continue
		}
		s.peers[p] = struct{}{}
		s.mutex.Unlock()
		go s.write(p)
		// The transport is output-only. A remote close or any client input closes the
		// peer immediately, including while no committed blocks are being produced.
		go func() { var b [1]byte; _, _ = p.conn.Read(b[:]); p.stop() }()
	}
}
func (s *Server) write(p *peer) {
	defer func() { p.stop(); s.mutex.Lock(); delete(s.peers, p); s.mutex.Unlock() }()
	for {
		select {
		case <-p.stopped:
			return
		case d := <-p.queue:
			if e := p.conn.SetWriteDeadline(time.Now().Add(s.timeout)); e != nil {
				return
			}
			for _, line := range d.lines {
				for len(line) > 0 {
					n, e := p.conn.Write(line)
					if e != nil || n == 0 {
						return
					}
					line = line[n:]
				}
			}
		}
	}
}
func (s *Server) enqueue(p *peer, d delivery) {
	select {
	case <-p.stopped:
		return
	default:
	}
	select {
	case p.queue <- d:
	default:
		p.stop()
	} // never silently drop a block
}
func (s *Server) invalidateLocked(from uint64, reason string) {
	raw, _ := line(struct {
		Type   string `json:"type"`
		From   string `json:"fromBlock"`
		Reason string `json:"reason"`
		Source Source `json:"executionSource"`
	}{"invalidate", strconv.FormatUint(from, 10), reason, s.manifest.Source()})
	for p := range s.peers {
		// Remove work not yet written on the abandoned branch. A frame already in the
		// socket cannot be recalled; on-chain anchor checks remain mandatory.
	drain:
		for {
			select {
			case <-p.queue:
			default:
				break drain
			}
		}
		s.enqueue(p, delivery{[][]byte{raw}})
		p.primed = false
	}
	s.last = nil
}
func (s *Server) Invalidate(from uint64, reason string) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if !s.closed {
		s.invalidateLocked(from, reason)
	}
}

// Commit must be called only after Nitro accepts the canonical block and while
// its execution/reorg lock is held. Capture does not issue RPCs and reads the
// exact block root via the adapter. Any capture failure closes all subscribers.
func (s *Server) Commit(h Head, r Reader, receipts []Receipt) error {
	batch, e := s.manifest.Capture(h, r, receipts)
	if e != nil {
		s.Close()
		return e
	}
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if s.closed {
		return errors.New("exporter closed")
	}
	if last := s.last; last != nil {
		if h.Number != last.Number+1 || h.Sequence != last.Sequence+1 || h.ParentHash != last.Hash || h.Timestamp < last.Timestamp {
			from := h.Number
			if from > last.Number+1 {
				from = last.Number + 1
			}
			s.invalidateLocked(from, "non-contiguous committed execution")
		}
	}
	for p := range s.peers {
		lines := make([][]byte, 0, 2+len(batch.Receipts))
		if len(batch.Costs) > 0 {
			lines = append(lines, batch.Costs)
		}
		if !p.primed {
			lines = append(lines, batch.Snapshot)
			p.primed = true
		} else {
			lines = append(lines, batch.Block)
			lines = append(lines, batch.Receipts...)
		}
		s.enqueue(p, delivery{lines})
	}
	copyHead := h
	s.last = &copyHead
	return nil
}
func (s *Server) Close() {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	_ = s.listener.Close()
	for p := range s.peers {
		p.stop()
	}
	s.last = nil
}
func (s *Server) String() string {
	return fmt.Sprintf("native export %s", s.manifest.Source().ManifestHash)
}

// Package filewatcher watches a directory for changes and provides
// gitignore-aware directory walking.
package filewatcher

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Change represents a single filesystem change.
type Change struct {
	Path string `json:"path"`
	Type string `json:"type"` // "added", "modified", "deleted"
}

// WalkEntry represents a file or directory found during walking.
type WalkEntry struct {
	Path string `json:"path"`
	Type string `json:"type"` // "file", "directory", "symlink", "other"
}

// Watcher monitors a directory for changes with debouncing.
type Watcher struct {
	done chan struct{}
	once sync.Once
}

// New starts watching the given directory. The callback is invoked with
// batched changes after debounceMs of inactivity.
//
// This uses a polling approach for maximum compatibility across filesystems
// (overlayfs, NFS, etc). The poll interval serves as the debounce window.
func New(root string, ignorePatterns []string, onChange func([]Change), opts ...time.Duration) *Watcher {
	debounce := 300 * time.Millisecond
	if len(opts) > 0 {
		debounce = opts[0]
	}

	w := &Watcher{done: make(chan struct{})}

	// Build a quick checker for ignore patterns
	shouldIgnore := func(rel string) bool {
		for _, p := range ignorePatterns {
			if strings.Contains(rel, p) {
				return true
			}
		}
		return false
	}

	// Snapshot: map[relPath]modTime
	type entry struct {
		modTime time.Time
		isDir   bool
	}
	takeSnapshot := func() map[string]entry {
		snap := make(map[string]entry)
		_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return nil
			}
			rel, _ := filepath.Rel(root, path)
			if rel == "." {
				return nil
			}
			if shouldIgnore(rel) {
				if info.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			snap[rel] = entry{modTime: info.ModTime(), isDir: info.IsDir()}
			return nil
		})
		return snap
	}

	go func() {
		prev := takeSnapshot()
		ticker := time.NewTicker(debounce)
		defer ticker.Stop()

		for {
			select {
			case <-w.done:
				return
			case <-ticker.C:
				curr := takeSnapshot()
				var changes []Change

				// Check for modified/deleted
				for path, pe := range prev {
					if ce, ok := curr[path]; ok {
						if !pe.isDir && ce.modTime.After(pe.modTime) {
							changes = append(changes, Change{Path: path, Type: "modified"})
						}
					} else {
						changes = append(changes, Change{Path: path, Type: "deleted"})
					}
				}
				// Check for added
				for path := range curr {
					if _, ok := prev[path]; !ok {
						changes = append(changes, Change{Path: path, Type: "added"})
					}
				}

				if len(changes) > 0 {
					onChange(changes)
				}
				prev = curr
			}
		}
	}()

	return w
}

// Close stops the watcher.
func (w *Watcher) Close() {
	w.once.Do(func() { close(w.done) })
}

// ---------- Directory walker with gitignore ----------

type gitIgnoreRule struct {
	negated bool
	regex   *regexp.Regexp
}

func globToRegexSource(pattern string) string {
	var s strings.Builder
	for i := 0; i < len(pattern); i++ {
		ch := pattern[i]
		switch ch {
		case '*':
			if i+1 < len(pattern) && pattern[i+1] == '*' {
				s.WriteString(".*")
				i++
			} else {
				s.WriteString("[^/]*")
			}
		case '?':
			s.WriteString("[^/]")
		case '\\', '^', '$', '+', '.', '(', ')', '|', '{', '}', '[', ']':
			s.WriteByte('\\')
			s.WriteByte(ch)
		default:
			s.WriteByte(ch)
		}
	}
	return s.String()
}

func parseGitIgnoreRule(line string) *gitIgnoreRule {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || strings.HasPrefix(trimmed, "#") {
		return nil
	}

	literal := strings.HasPrefix(trimmed, "\\#") || strings.HasPrefix(trimmed, "\\!")
	negated := !literal && strings.HasPrefix(trimmed, "!")
	rawPattern := trimmed
	if negated {
		rawPattern = trimmed[1:]
	} else if literal {
		rawPattern = trimmed[1:]
	}
	if rawPattern == "" {
		return nil
	}

	directoryOnly := strings.HasSuffix(rawPattern, "/")
	anchored := strings.HasPrefix(rawPattern, "/")

	normalized := rawPattern
	if anchored {
		normalized = normalized[1:]
	}
	if directoryOnly {
		normalized = strings.TrimSuffix(normalized, "/")
	}
	if normalized == "" {
		return nil
	}

	hasSlash := strings.Contains(normalized, "/")
	source := globToRegexSource(normalized)

	var pattern string
	if !hasSlash {
		if directoryOnly {
			pattern = "(^|/)" + source + "(/|$)"
		} else {
			pattern = "(^|/)" + source + "$"
		}
	} else if anchored {
		if directoryOnly {
			pattern = "^" + source + "(/|$)"
		} else {
			pattern = "^" + source + "$"
		}
	} else {
		if directoryOnly {
			pattern = "(^|.*/)" + source + "(/|$)"
		} else {
			pattern = "(^|.*/)" + source + "$"
		}
	}

	re, err := regexp.Compile(pattern)
	if err != nil {
		return nil
	}
	return &gitIgnoreRule{negated: negated, regex: re}
}

func loadGitIgnoreRules(root string) []*gitIgnoreRule {
	rules := []*gitIgnoreRule{parseGitIgnoreRule(".git/")}

	// Extra ignore patterns from env
	if extra := os.Getenv("FILE_WATCHER_IGNORE"); extra != "" {
		for _, p := range strings.Split(extra, ",") {
			if r := parseGitIgnoreRule(strings.TrimSpace(p)); r != nil {
				rules = append(rules, r)
			}
		}
	}

	f, err := os.Open(filepath.Join(root, ".gitignore"))
	if err != nil {
		return rules
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		if r := parseGitIgnoreRule(scanner.Text()); r != nil {
			rules = append(rules, r)
		}
	}
	return rules
}

func isGitIgnored(path string, rules []*gitIgnoreRule) bool {
	ignored := false
	for _, r := range rules {
		if r.regex.MatchString(path) {
			ignored = !r.negated
		}
	}
	return ignored
}

// WalkDirectory recursively walks a directory, respecting .gitignore rules.
func WalkDirectory(root string) ([]WalkEntry, error) {
	rules := loadGitIgnoreRules(root)
	var entries []WalkEntry

	var walk func(dir string) error
	walk = func(dir string) error {
		dirents, err := os.ReadDir(dir)
		if err != nil {
			return nil // Skip unreadable directories
		}
		for _, d := range dirents {
			fullPath := filepath.Join(dir, d.Name())
			relPath, _ := filepath.Rel(root, fullPath)

			if isGitIgnored(relPath, rules) {
				continue
			}

			if d.IsDir() {
				entries = append(entries, WalkEntry{Path: relPath, Type: "directory"})
				_ = walk(fullPath)
			} else if d.Type()&os.ModeSymlink != 0 {
				entries = append(entries, WalkEntry{Path: relPath, Type: "symlink"})
			} else if d.Type().IsRegular() {
				entries = append(entries, WalkEntry{Path: relPath, Type: "file"})
			} else {
				entries = append(entries, WalkEntry{Path: relPath, Type: "other"})
			}
		}
		return nil
	}

	err := walk(root)
	return entries, err
}

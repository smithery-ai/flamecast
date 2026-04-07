// Package vitals publishes periodic system metrics (CPU, memory) over a
// WebSocket hub channel ("system:vitals").
package vitals

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Publisher periodically samples system vitals and calls a publish function.
type Publisher struct {
	interval time.Duration
	publish  func(data map[string]any)
	stopCh   chan struct{}
}

// NewPublisher creates a vitals publisher that calls publish every interval.
func NewPublisher(interval time.Duration, publish func(data map[string]any)) *Publisher {
	return &Publisher{
		interval: interval,
		publish:  publish,
		stopCh:   make(chan struct{}),
	}
}

// Start begins the periodic sampling loop in a goroutine.
func (p *Publisher) Start() {
	go p.loop()
}

// Stop halts the publisher.
func (p *Publisher) Stop() {
	close(p.stopCh)
}

func (p *Publisher) loop() {
	prev := readCPUSample()

	ticker := time.NewTicker(p.interval)
	defer ticker.Stop()

	for {
		select {
		case <-p.stopCh:
			return
		case <-ticker.C:
			cur := readCPUSample()
			cpuPercent := computeCPUPercent(prev, cur)
			prev = cur

			mem := readMemInfo()

			p.publish(map[string]any{
				"cpuPercent":   round2(cpuPercent),
				"memTotalMB":   mem.totalMB,
				"memUsedMB":    mem.usedMB,
				"memPercent":   round2(mem.percent),
				"memAvailMB":   mem.availMB,
			})
		}
	}
}

// ---------- CPU sampling from /proc/stat ----------

type cpuSample struct {
	idle  uint64
	total uint64
}

func readCPUSample() cpuSample {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return cpuSample{}
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 5 {
			return cpuSample{}
		}
		// fields: cpu user nice system idle iowait irq softirq steal guest guest_nice
		var total, idle uint64
		for i := 1; i < len(fields); i++ {
			v, _ := strconv.ParseUint(fields[i], 10, 64)
			total += v
			if i == 4 { // idle
				idle = v
			}
		}
		return cpuSample{idle: idle, total: total}
	}
	return cpuSample{}
}

func computeCPUPercent(prev, cur cpuSample) float64 {
	totalDelta := cur.total - prev.total
	if totalDelta == 0 {
		return 0
	}
	idleDelta := cur.idle - prev.idle
	return float64(totalDelta-idleDelta) / float64(totalDelta) * 100
}

// ---------- Memory from /proc/meminfo ----------

type memInfo struct {
	totalMB  int64
	availMB  int64
	usedMB   int64
	percent  float64
}

func readMemInfo() memInfo {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return memInfo{}
	}
	defer f.Close()

	var totalKB, availKB int64
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "MemTotal:"):
			totalKB = parseMemInfoValue(line)
		case strings.HasPrefix(line, "MemAvailable:"):
			availKB = parseMemInfoValue(line)
		}
		if totalKB > 0 && availKB > 0 {
			break
		}
	}

	totalMB := totalKB / 1024
	availMB := availKB / 1024
	usedMB := totalMB - availMB
	var percent float64
	if totalMB > 0 {
		percent = float64(usedMB) / float64(totalMB) * 100
	}
	return memInfo{totalMB: totalMB, availMB: availMB, usedMB: usedMB, percent: percent}
}

func parseMemInfoValue(line string) int64 {
	// e.g. "MemTotal:       16384000 kB"
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return 0
	}
	v, _ := strconv.ParseInt(fields[1], 10, 64)
	return v
}

func round2(v float64) float64 {
	return float64(int(v*100+0.5)) / 100
}

// FormatLog returns a one-line summary for debug logging.
func FormatLog(data map[string]any) string {
	return fmt.Sprintf("cpu=%.1f%% mem=%dMB/%dMB (%.1f%%)",
		data["cpuPercent"], data["memUsedMB"], data["memTotalMB"], data["memPercent"])
}

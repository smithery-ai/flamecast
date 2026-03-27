package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithery-ai/flamecast/packages/session-host-go/ws"
)

func TestFormatStartupOutputEmpty(t *testing.T) {
	if got := formatStartupOutput(""); got != "" {
		t.Fatalf("expected empty output, got %q", got)
	}
}

func TestFormatStartupOutputIncludesTrimmedTail(t *testing.T) {
	longOutput := strings.Repeat("a", 5000)

	got := formatStartupOutput(longOutput)

	if !strings.HasPrefix(got, "\nStartup output:\n") {
		t.Fatalf("expected startup output prefix, got %q", got)
	}
	if strings.Contains(got, strings.Repeat("a", 4500)) {
		t.Fatalf("expected output to be trimmed, got %d chars", len(got))
	}
	if !strings.Contains(got, strings.Repeat("a", 4000)) {
		t.Fatalf("expected output to include the most recent bytes")
	}
}

func TestHandlePromptHTTPRequiresActiveSession(t *testing.T) {
	resetSession()

	req := httptest.NewRequest(http.MethodPost, "/prompt", strings.NewReader(`{"text":"hi"}`))
	rec := httptest.NewRecorder()

	handlePromptHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d", http.StatusBadRequest, rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "No active session") {
		t.Fatalf("expected no active session error, got %q", rec.Body.String())
	}
}

func TestHandlePermissionHTTPReturnsNotFoundWithoutResolver(t *testing.T) {
	resetSession()
	t.Cleanup(resetSession)

	current.Lock()
	current.sess = &session{
		handler: newClientHandler(ws.NewHub(), "/tmp"),
	}
	current.Unlock()

	req := httptest.NewRequest(
		http.MethodPost,
		"/permissions/request-1",
		strings.NewReader(`{"optionId":"allow"}`),
	)
	req.SetPathValue("requestID", "request-1")
	rec := httptest.NewRecorder()

	handlePermissionHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d", http.StatusNotFound, rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Permission request request-1 not found") {
		t.Fatalf("expected missing permission request error, got %q", rec.Body.String())
	}
}

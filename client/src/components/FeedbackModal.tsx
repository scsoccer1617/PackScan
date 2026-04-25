import { useEffect, useState } from "react";
import { MessageSquare, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";

/**
 * Beta feedback affordance. Renders as a small icon button that opens a
 * modal where testers leave structured feedback (Bug / Idea / Question /
 * Other + free text). Submission posts to /api/feedback which appends a
 * new row to the admin's feedback Google Sheet.
 *
 * Design rationale:
 *   - One sheet, one tab, one row per submission. We don't grade or route
 *     feedback in-app — the admin reads the sheet directly.
 *   - We capture a tiny envelope of context (current page URL, user agent)
 *     server-side so the admin can see where the bug was reported from
 *     without asking a follow-up. The user's email comes from the
 *     authenticated session, not the form, so they can't spoof it.
 *   - The button is hidden for unauthenticated users — there's nowhere for
 *     anonymous feedback to attribute and we don't want to pay sheet API
 *     calls for spam.
 */
export default function FeedbackButton() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<"Bug" | "Idea" | "Question" | "Other">("Bug");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Reset form whenever the modal opens so a previous draft doesn't bleed
  // into a fresh submission. We intentionally do NOT persist drafts —
  // beta feedback is short and the friction of typing it again is fine if
  // the user accidentally closes the modal mid-message.
  useEffect(() => {
    if (open) {
      setCategory("Bug");
      setMessage("");
    }
  }, [open]);

  if (!user) return null;

  const submit = async () => {
    const trimmed = message.trim();
    if (!trimmed) {
      toast({ title: "Add a quick note before sending.", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      await apiRequest({
        url: "/api/feedback",
        method: "POST",
        body: {
          category,
          message: trimmed,
          // window.location is fine here — the modal only renders client-side.
          pageUrl: typeof window !== "undefined" ? window.location.href : null,
        },
      });
      toast({ title: "Thanks — feedback received." });
      setOpen(false);
    } catch (err: any) {
      // 503 → admin hasn't connected sheets yet. Fall through to a friendly
      // message for either case rather than dumping a stack trace at the user.
      const msg = err?.message?.includes("503") || err?.message?.includes("feedback_unavailable")
        ? "Feedback is temporarily unavailable. Try again in a minute."
        : "Couldn't send feedback. Please try again.";
      toast({ title: msg, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-9 h-9 rounded-full hover:bg-muted flex items-center justify-center text-slate-500 transition-colors"
        aria-label="Send feedback"
        data-testid="button-feedback"
        title="Send feedback"
      >
        <MessageSquare className="w-[18px] h-[18px]" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-feedback">
          <DialogHeader>
            <DialogTitle>Send feedback</DialogTitle>
            <DialogDescription>
              Tell us what's working, what isn't, or what you wish PackScan did. This goes
              straight to the dev.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 mt-2">
            <div className="grid gap-1.5">
              <Label htmlFor="feedback-category">Category</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as any)}>
                <SelectTrigger id="feedback-category" data-testid="select-feedback-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Bug">Bug — something broke</SelectItem>
                  <SelectItem value="Idea">Idea — feature request</SelectItem>
                  <SelectItem value="Question">Question — I'm stuck</SelectItem>
                  <SelectItem value="Other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="feedback-message">Message</Label>
              <Textarea
                id="feedback-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="What happened? Steps to reproduce a bug, or what you'd like to see…"
                rows={5}
                maxLength={4000}
                data-testid="input-feedback-message"
              />
              <div className="text-[11px] text-slate-500 text-right tabular-nums">
                {message.length} / 4000
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-4">
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={submitting}
              data-testid="button-feedback-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={submitting || message.trim().length === 0}
              data-testid="button-feedback-submit"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Sending…
                </>
              ) : (
                "Send"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

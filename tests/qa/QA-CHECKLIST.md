# QA Manual Testing Checklist

## WhatsApp AI Chatbot - Quality Assurance Checklist

---

## 🔐 Authentication & Security

### Login Flow
- [ ] Login page loads correctly
- [ ] Wrong password shows error message
- [ ] Correct password grants access
- [ ] Rate limiting works (5 failed attempts → blocked)
- [ ] Session token is valid
- [ ] Logout clears session

### API Security
- [ ] Unauthenticated requests return 401
- [ ] Invalid tokens are rejected
- [ ] CORS headers are present

---

## 💬 Chat Functionality

### Message Reception
- [ ] WhatsApp webhook receives messages
- [ ] Messages appear in dashboard
- [ ] Deduplication works (same message not processed twice)
- [ ] Image messages are received
- [ ] Audio/document messages are handled gracefully

### AI Response
- [ ] AI responds to customer messages
- [ ] Response delay is natural (not instant)
- [ ] Split bubble [SPLIT] works correctly
- [ ] Product images are sent when requested
- [ ] Escalation tags [ESCALATE] work

### Order Processing
- [ ] [ORDER_DATA] tag extracts order correctly
- [ ] Duplicate orders within 5 minutes are rejected
- [ ] Order appears in dashboard
- [ ] Order status updates work

---

## 📦 Feature Testing

### Product Knowledge Base
- [ ] Product blocks are parsed correctly
- [ ] Relevant products are matched to queries
- [ ] "All products" query returns all blocks
- [ ] Knowledge base formatting works

### Shipping (Ongkir)
- [ ] [CEK_ONGKIR] tag triggers calculation
- [ ] Shipping costs are displayed correctly
- [ ] Invalid locations are handled gracefully

### Payment
- [ ] Transfer instructions are shown
- [ ] COD instructions are shown
- [ ] [BUKTI_TRANSFER] tag works
- [ ] Payment follow-up timer triggers

### Escalation
- [ ] [ESCALATE] tag sends to admin
- [ ] Admin can answer escalations
- [ ] Answers are saved to knowledge base

### Warranty Claims
- [ ] [KLAIM_GARANSI] tag is processed
- [ ] Claim photos are forwarded to admin
- [ ] Active claims are tracked

---

## 🔄 State Management

### Persistence
- [ ] Messages survive server restart
- [ ] Orders survive server restart
- [ ] Settings survive server restart
- [ ] Processed wamids (dedup) survive restart
- [ ] Active claims survive restart

### In-Memory State
- [ ] Debounce buffer works (multiple bubbles → single response)
- [ ] User locks prevent concurrent processing
- [ ] Active processing can be cancelled on new message

---

## 📊 Dashboard

### Messages View
- [ ] Messages list loads
- [ ] Message details expand
- [ ] AI replies are shown
- [ ] Manual reply button works
- [ ] Image previews load

### Orders View
- [ ] Orders list loads
- [ ] Order status can be updated
- [ ] Order details show correctly
- [ ] AI address extraction works
- [ ] COD status is displayed

### Settings View
- [ ] All settings load correctly
- [ ] Save settings works
- [ ] API key management works
- [ ] Product images upload/delete works

### Key Status
- [ ] API key status is displayed
- [ ] Quota information is shown
- [ ] Key rotation works

---

## 🌐 Webhook Testing

### Meta Webhook
- [ ] Verification handshake works
- [ ] Messages are received
- [ ] Status updates are processed
- [ ] Signature validation works

### MacroDroid Bridge
- [ ] Bridge token validation works
- [ ] Messages from Android are received
- [ ] Responses are sent back correctly

---

## ⚡ Performance & Reliability

### Rate Limiting
- [ ] Login rate limiting works
- [ ] API key rotation works
- [ ] Retry logic works for failed messages

### Error Handling
- [ ] Server doesn't crash on errors
- [ ] Errors are logged properly
- [ ] Graceful degradation works

### Load Testing
- [ ] Multiple concurrent messages handled
- [ ] Memory usage is stable
- [ ] No memory leaks observed

---

## 🧪 Test Commands

```bash
# Run all automated tests
npm test

# Run unit tests only
npm run test:unit

# Run integration tests only
npm run test:integration

# Run QA test runner
npm run test:qa

# Run tests in watch mode
npm run test:watch
```

---

## 📝 Test Results Template

| Date | Tester | Environment | Passed | Failed | Notes |
|------|--------|-------------|--------|--------|-------|
| | | | | | |

---

## 🐛 Bug Report Template

**Title:** [Brief description]

**Environment:**
- Node.js version:
- Browser:
- Device:

**Steps to Reproduce:**
1.
2.
3.

**Expected Result:**

**Actual Result:**

**Screenshots/Logs:**

**Priority:** [Critical/High/Medium/Low]

---

## ✅ Sign Off

- [ ] All critical tests passed
- [ ] All high priority tests passed
- [ ] No blocking bugs found
- [ ] Ready for deployment

**Reviewed by:** _________________ **Date:** _________________

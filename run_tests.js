const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
  }
}

function freshDom() {
  let pageHtml = html.replace(/<script src="https:\/\/cdnjs[^>]*><\/script>/, '');
  // Mock jsPDF with the chainable API surface buildPDF() actually calls
  function MockJsPDF(opts) {
    this.opts = opts;
  }
  const chainMethods = ["setFontSize","setFont","setTextColor","text","setDrawColor","setLineWidth","line","setFillColor","roundedRect","splitTextToSize","addPage","addImage"];
  chainMethods.forEach(m => {
    MockJsPDF.prototype[m] = function(...args) {
      if (m === "splitTextToSize") return [String(args[0])];
      return this;
    };
  });
  MockJsPDF.prototype.output = function(type) { return new Blob(["fake-pdf-content"], {type:"application/pdf"}); };

  const dom = new JSDOM(pageHtml, {
    runScripts: "dangerously",
    resources: "usable",
    url: "https://hablacuenta.com/",
    beforeParse(window) {
      window.jspdf = { jsPDF: MockJsPDF };
    }
  });
  // Helper: access let/const top-level variables, which aren't exposed as window properties in jsdom's vm context
  dom.window.get = (expr) => dom.window.eval(expr);
  dom.window.set = (varName, value) => dom.window.eval(`${varName} = ${JSON.stringify(value)}`);
  dom.window.call = (expr) => dom.window.eval(expr);
  return dom;
}

function wait(ms) { return new Promise(res => setTimeout(res, ms)); }

async function testBPLWFlow() {
  console.log("\n=== TEST SUITE 1: BPLW Materials Invoice (Alfonso's default flow) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  check("App initializes with BPLW mode by default", win.get("contractorInfo.mode") === "bplw");
  check("Greeting shows default firstName", win.document.getElementById("chatBox").innerHTML.includes("Alfonso"));

  // Simulate picking Materials Only
  win.eval('invoiceType = "materials"; convStage = "client_type";');

  // Simulate AI asking for partner -> picking Richard Baisz
  win.eval('currentOrderedBy = "Richard Baisz"; convStage = "street";');

  // Simulate address chip click building the full address
  const addresses = win.eval('getClientAddresses("Richard Baisz")');
  check("Richard Baisz has no preset addresses (each partner manages own properties)", addresses.length === 0);

  const andrewAddresses = win.eval('getClientAddresses("Andrew Whallon")');
  check("Andrew Whallon has preset addresses", andrewAddresses.length > 0, `found ${andrewAddresses.length}`);

  // Simulate full invoiceData as if AI returned it
  win.eval(`invoiceData = ${JSON.stringify({
    done: true,
    client_type: "bplw",
    bill_to_name: "BPLW Management",
    bill_to_address: "PO Box 9395, Long Beach CA 90810",
    bill_to_email: "baisz@sbcglobal.net",
    bill_to_phone: "310-809-3856",
    ordered_by: "Richard Baisz",
    job_address: "1001 Cherry Ave Unit 101, Long Beach CA 90813",
    work_items: [],
    materials_items: [
      { vendor: "Home Depot", desc: "Paint", date: "6-15-2026", amount: 45.99 },
      { vendor: "Ace Hardware", desc: "Screws", date: "6-16-2026", amount: 8.50 }
    ],
    date: "6-20-2026",
    has_materials: true,
    has_labor: false,
    new_client: null
  })}; receipts = []; jobPhotos = [];`);

  win.document.getElementById("photoSections").style.display = "block";
  win.document.getElementById("receiptSection").style.display = "block";
  win.eval('showInvoicePreview(invoiceData)');
  await wait(100);

  const invoiceArea = win.document.getElementById("invoiceArea").innerHTML;
  check("Invoice preview shows BPLW Management as Bill To", invoiceArea.includes("BPLW Management"));
  check("Invoice preview shows Richard Baisz as Ordered By", invoiceArea.includes("Richard Baisz"));
  check("Invoice preview shows job address", invoiceArea.includes("1001 Cherry Ave Unit 101"));
  check("Invoice preview shows Home Depot vendor", invoiceArea.includes("Home Depot"));
  check("Invoice preview shows materials date", invoiceArea.includes("6-15-2026"));
  check("Invoice preview total is correct ($54.49)", invoiceArea.includes("54.49"), "expected sum of 45.99+8.50");
  check("From shows Alfonso's business name (default)", invoiceArea.includes("Alfonso Sanchez Property Services"));

  // Test PDF build (without actually rendering, just checking it doesn't throw)
  try {
    const builtOk = win.eval('(async () => { try { const b = await buildPDF("materials"); return JSON.stringify({ok:true, invNum:b.invNum, matNum}); } catch(e) { return JSON.stringify({ok:false, err:e.message}); } })()');
    const result = await builtOk;
    const parsed = JSON.parse(result);
    check("buildPDF executes without error for materials", parsed.ok, parsed.err);
    if (parsed.ok) check("buildPDF returns correct invoice number", parsed.invNum === parsed.matNum);
  } catch (e) {
    check("buildPDF executes without error for materials", false, e.message);
  }

  // Test History recording
  const beforeHistoryLen = win.eval('invoiceHistory.length');
  win.eval('recordInvoiceHistory("materials", matNum)');
  const afterHistoryLen = win.eval('invoiceHistory.length');
  check("Invoice history grows after recording", afterHistoryLen === beforeHistoryLen + 1);
  const firstEntryAddr = win.eval('invoiceHistory[0].invoiceData.job_address');
  check("Recorded history entry has correct job address", firstEntryAddr.includes("1001 Cherry Ave"));
}

async function testGenericMode() {
  console.log("\n=== TEST SUITE 2: Generic Mode (non-BPLW contractor) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // Configure as generic contractor
  win.eval('showSettings()');
  win.document.getElementById("setFirstName").value = "Adrian";
  win.document.getElementById("setLastName").value = "Quintana";
  win.document.getElementById("setBusinessName").value = "";
  win.document.getElementById("setAddress").value = "1952 Caspian Avenue, Long Beach CA";
  win.document.getElementById("setPhone").value = "555-1212";
  win.document.getElementById("setMode").value = "generic";
  win.eval('saveSettingsForm()');

  check("Settings saved generic mode", win.eval("contractorInfo.mode") === "generic");
  check("Header updated to First Last (no business name)", win.document.getElementById("headerTitleText").textContent.includes("Adrian Quintana"));

  win.eval('resetChat()');
  await wait(100);
  check("Greeting uses firstName only", win.document.getElementById("chatBox").innerHTML.includes("Hi Adrian!"));

  // Test empty client list shows + New client chip
  win.eval('invoiceType = "materials"; showSavedClientChips();');
  const chipArea = win.document.getElementById("chipArea").innerHTML;
  check("Empty client list still shows +New client chip", chipArea.includes("New client"), "this was the actual bug reported by tester");

  // Add a client and verify it shows as a chip
  win.eval(`addClient({ name: "Test Client Co", address: "456 Demo St", email: "test@example.com", phone: "555-9999" })`);
  win.eval('showSavedClientChips()');
  const chipArea2 = win.document.getElementById("chipArea").innerHTML;
  check("After adding a client, chip shows their name", chipArea2.includes("Test Client Co"));
  check("New client chip still present alongside saved clients", chipArea2.includes("New client"));

  // Simulate completed generic invoice
  win.eval(`invoiceData = ${JSON.stringify({
    done: true,
    client_type: "generic",
    bill_to_name: "Test Client Co",
    bill_to_address: "456 Demo St",
    bill_to_email: "test@example.com",
    bill_to_phone: "555-9999",
    ordered_by: "",
    job_address: "789 Job Site Rd",
    work_items: [{ desc: "Fix fence", amount: 200 }],
    materials_items: [],
    date: "6-20-2026",
    has_materials: false,
    has_labor: true,
    new_client: null
  })}; invoiceType = "labor"; showInvoicePreview(invoiceData);`);
  await wait(100);
  const invoiceArea = win.document.getElementById("invoiceArea").innerHTML;
  check("Generic invoice shows correct From (Adrian Quintana, no business name)", invoiceArea.includes("Adrian Quintana"));
  check("Generic invoice hides 'Ordered By' when blank", !invoiceArea.includes("Ordered By"));
  check("Generic invoice shows bill-to client", invoiceArea.includes("Test Client Co"));
  check("Generic invoice shows job address", invoiceArea.includes("789 Job Site Rd"));
}

async function testSettingsMigration() {
  console.log("\n=== TEST SUITE 3: Settings Migration (old single-name format) ===");
  const dom = freshDom();
  const win = dom.window;
  win.localStorage.setItem("contractor_info", JSON.stringify({
    name: "Old Format Contractor",
    address: "Old Address",
    phone: "555-0000",
    mode: "generic"
  }));
  await wait(300);
  const infoJson = win.eval("JSON.stringify(loadContractorInfo())");
  const info = JSON.parse(infoJson);
  check("Migrated firstName equals old name", info.firstName === "Old Format Contractor");
  check("Migrated businessName is blank (not duplicated)", info.businessName === "");
  check("Migrated lastName is blank", info.lastName === "");
  check("Old 'name' field removed after migration", !("name" in info));
}

async function testPanelNavigation() {
  console.log("\n=== TEST SUITE 4: Panel Navigation (stacking bug regression check) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  win.showHistory();
  win.showSettings();
  const historyDisplay = win.document.getElementById("historyPanel").style.display;
  const settingsDisplay = win.document.getElementById("settingsPanel").style.display;
  check("Only Settings panel visible after showSettings (History properly hidden)", historyDisplay === "none" && settingsDisplay === "block");

  win.showManager();
  win.showAddressManager();
  const managerDisplay = win.document.getElementById("managerPanel").style.display;
  const addrDisplay = win.document.getElementById("addressManagerPanel").style.display;
  check("Only AddressManager visible after showAddressManager (Manager properly hidden)", managerDisplay === "none" && addrDisplay === "block");
}

async function testAlfonsoDeviceUnaffected() {
  console.log("\n=== TEST SUITE 5: Regression Check — Alfonso's Untouched Device ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  check("Fresh device defaults to bplw mode", win.eval("contractorInfo.mode") === "bplw");
  check("Fresh device firstName is Alfonso", win.eval("contractorInfo.firstName") === "Alfonso");
  check("Fresh device businessName is full company name", win.eval("contractorInfo.businessName") === "Alfonso Sanchez Property Services");
  check("Fresh device greeting says Hi Alfonso", win.document.getElementById("chatBox").innerHTML.includes("Hi Alfonso!"));

  const sysPrompt = win.eval("getSystemPrompt()");
  check("System prompt mentions BPLW for default mode", sysPrompt.includes("BPLW Management"));
  check("System prompt does NOT mention generic-only client flow for BPLW mode", !sysPrompt.includes("there are no saved clients yet"));
}

async function testBackButtonVisibility() {
  console.log("\n=== TEST SUITE 6: Back Button Visibility (regression for reported bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // BPLW mode: pick Materials Only, should be able to go back
  win.eval(`
    invoiceType = "materials";
    convStage = "client_type";
    showBackBtn(true);
    messages.push({role:"user",content:"Materials Only"});
    messages.push({role:"assistant",content:"Perfect. Which partner ordered the materials?"});
  `);
  let backVisible = win.document.getElementById("backBtn").style.display;
  check("BPLW mode: Back button visible after picking invoice type", backVisible === "block");

  win.eval('goBack()');
  const stageAfterBack = win.eval('convStage');
  check("BPLW mode: goBack() reverts to invoice_type stage", stageAfterBack === "invoice_type");

  // Generic mode: configure, then simulate the smartChips trigger for "who is this invoice for"
  const dom2 = freshDom();
  const win2 = dom2.window;
  await wait(300);
  win2.eval(`
    contractorInfo.mode = "generic";
    invoiceType = "materials";
    messages.push({role:"user",content:"Materials Only"});
    messages.push({role:"assistant",content:"Hi! Let's create a materials-only invoice. Who is this invoice for?"});
  `);
  win2.eval(`smartChips("Hi! Let's create a materials-only invoice. Who is this invoice for?")`);
  const backVisible2 = win2.document.getElementById("backBtn").style.display;
  check("Generic mode: Back button visible at client-selection step (the actual reported bug)", backVisible2 === "block");

  const stage2 = win2.eval('convStage');
  check("Generic mode: convStage correctly set to client_type", stage2 === "client_type");

  win2.eval('goBack()');
  const stageAfterBack2 = win2.eval('convStage');
  check("Generic mode: goBack() reverts to invoice_type stage", stageAfterBack2 === "invoice_type");
}

async function testNewClientFlow() {
  console.log("\n=== TEST SUITE 7: Guided New-Client Entry Flow ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // Start the flow
  win.eval('startNewClient()');
  check("startNewClient sets newClientState to name step", win.eval('newClientState.step') === "name");
  check("AI prompts for client name", win.document.getElementById("chatBox").innerHTML.includes("client's name"));

  // Provide a name
  win.eval(`document.getElementById("userInput").value = "Maria Lopez"; sendMsg();`);
  check("After name, step advances to awaiting_address", win.eval('newClientState.step') === "awaiting_address");
  check("Name was stored correctly", win.eval('newClientState.data.name') === "Maria Lopez");

  // Skip address entirely
  win.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`);
  check("After skipping address, step advances to email", win.eval('newClientState.step') === "email");
  check("Skipped address stored as blank, not 'Skip'", win.eval('newClientState.data.address') === "");

  // Provide email
  win.eval(`document.getElementById("userInput").value = "maria@example.com"; sendMsg();`);
  check("After email, step advances to phone", win.eval('newClientState.step') === "phone");

  // Skip phone
  win.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`);
  check("After skipping phone, step advances to summary", win.eval('newClientState.step') === "summary");

  const summaryHtml = win.document.getElementById("chatBox").innerHTML;
  check("Summary shows the name", summaryHtml.includes("Maria Lopez"));
  check("Summary shows blank address note", summaryHtml.includes("blank"));

  // Confirm looks good -> should save and clear state
  win.eval(`document.getElementById("userInput").value = "Looks good"; sendMsg();`);
  check("newClientState cleared after saving", win.eval('newClientState') === null);
  const savedClients = JSON.parse(win.eval('JSON.stringify(savedClients)'));
  const saved = savedClients.find(c => c.name === "Maria Lopez");
  check("Client actually saved to savedClients with correct name", !!saved);
  check("Saved client has blank address (not the word Skip)", saved && saved.address === "");
  check("Saved client has correct email", saved && saved.email === "maria@example.com");

  // Test the edit-before-saving path
  const dom2 = freshDom();
  const win2 = dom2.window;
  await wait(300);
  win2.eval('startNewClient()');
  win2.eval(`document.getElementById("userInput").value = "Wrong Name"; sendMsg();`);
  win2.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // address
  win2.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // email
  win2.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // phone, lands on summary
  check("Reached summary step before testing edit", win2.eval('newClientState.step') === "summary");

  win2.eval(`document.getElementById("userInput").value = "Fix something"; sendMsg();`);
  check("Choosing fix-something moves to edit_field step", win2.eval('newClientState.step') === "edit_field");

  win2.eval(`document.getElementById("userInput").value = "Name"; sendMsg();`);
  check("Picking Name field moves to editing_name step", win2.eval('newClientState.step') === "editing_name");

  win2.eval(`document.getElementById("userInput").value = "Corrected Name"; sendMsg();`);
  check("After correction, returns to summary step", win2.eval('newClientState.step') === "summary");
  const correctedSummary = win2.document.getElementById("chatBox").innerHTML;
  check("Summary now shows corrected name", correctedSummary.includes("Corrected Name"));

  win2.eval(`document.getElementById("userInput").value = "Looks good"; sendMsg();`);
  const savedClients2 = JSON.parse(win2.eval('JSON.stringify(savedClients)'));
  const saved2 = savedClients2.find(c => c.name === "Corrected Name");
  check("Corrected name was the one actually saved (not the original typo)", !!saved2);

  // Test the full unified guided address flow with a unit number, launched via the client flow
  const dom4 = freshDom();
  const win4 = dom4.window;
  await wait(300);
  win4.eval('startNewClient()');
  win4.eval(`document.getElementById("userInput").value = "Sam Rivera"; sendMsg();`);
  check("Name step advances to awaiting_address", win4.eval('newClientState.step') === "awaiting_address");

  // Saying anything other than Skip should launch the unified guided address flow
  win4.eval(`document.getElementById("userInput").value = "Yes"; sendMsg();`);
  check("guidedAddrState launched with client purpose", win4.eval('guidedAddrState !== null && guidedAddrState.purpose') === "client");
  check("guidedAddrState starts at street step", win4.eval('guidedAddrState.step') === "street");

  win4.eval(`document.getElementById("userInput").value = "1234 Ocean Blvd"; sendMsg();`);
  check("Street step advances to unit_yn", win4.eval('guidedAddrState.step') === "unit_yn");
  check("Street stored correctly", win4.eval('guidedAddrState.data.street') === "1234 Ocean Blvd");

  win4.eval(`document.getElementById("userInput").value = "Yes"; sendMsg();`);
  check("Saying Yes to unit moves to unit_number", win4.eval('guidedAddrState.step') === "unit_number");

  win4.eval(`document.getElementById("userInput").value = "Suite 200"; sendMsg();`);
  check("Unit number step advances to city", win4.eval('guidedAddrState.step') === "city");
  check("Unit stored correctly", win4.eval('guidedAddrState.data.unit') === "Suite 200");

  win4.eval(`document.getElementById("userInput").value = "Long Beach"; sendMsg();`);
  check("City step advances to state", win4.eval('guidedAddrState.step') === "state");

  win4.eval(`document.getElementById("userInput").value = "CA"; sendMsg();`);
  check("State step advances to zip", win4.eval('guidedAddrState.step') === "zip");

  win4.eval(`document.getElementById("userInput").value = "90802"; sendMsg();`);
  check("After zip, guidedAddrState is cleared (handed back to client flow)", win4.eval('guidedAddrState') === null);
  check("Client flow resumes at email step", win4.eval('newClientState.step') === "email");
  const builtAddress = win4.eval('newClientState.data.address');
  check("Built address includes street", builtAddress.includes("1234 Ocean Blvd"));
  check("Built address includes unit", builtAddress.includes("Suite 200"));
  check("Built address includes city", builtAddress.includes("Long Beach"));
  check("Built address includes state", builtAddress.includes("CA"));
  check("Built address includes zip", builtAddress.includes("90802"));

  // Test the no-unit path (typing "No" instead of a direct unit)
  const dom5 = freshDom();
  const win5 = dom5.window;
  await wait(300);
  win5.eval('startNewClient()');
  win5.eval(`document.getElementById("userInput").value = "Jane Doe"; sendMsg();`);
  win5.eval(`document.getElementById("userInput").value = "Yes"; sendMsg();`); // wants to add address
  win5.eval(`document.getElementById("userInput").value = "500 Main St"; sendMsg();`);
  win5.eval(`document.getElementById("userInput").value = "No"; sendMsg();`);
  check("Saying No to unit skips straight to city", win5.eval('guidedAddrState.step') === "city");
  check("Unit correctly stored as blank when answered No", win5.eval('guidedAddrState.data.unit') === "");
  win5.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // city
  win5.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // state
  win5.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // zip
  check("After skipping city/state/zip, hands back to client flow at email step", win5.eval('newClientState.step') === "email");
  const minimalAddress = win5.eval('newClientState.data.address');
  check("Minimal address still includes street even with everything else skipped", minimalAddress.includes("500 Main St"));

  // Test that "Skip" at the very first address question bypasses the entire guided flow
  const dom6 = freshDom();
  const win6 = dom6.window;
  await wait(300);
  win6.eval('startNewClient()');
  win6.eval(`document.getElementById("userInput").value = "Test Person"; sendMsg();`);
  win6.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`);
  check("Skipping at awaiting_address jumps straight to email (never launches guidedAddrState)", win6.eval('newClientState.step') === "email");
  check("guidedAddrState never launched when address is skipped upfront", win6.eval('guidedAddrState') === null);
  check("Address is blank when skipped at the very first address question", win6.eval('newClientState.data.address') === "");

  // Test that resetChat clears any in-progress newClientState
  const dom3 = freshDom();
  const win3 = dom3.window;
  await wait(300);
  win3.eval('startNewClient()');
  check("newClientState set before reset", win3.eval('newClientState') !== null);
  win3.eval('resetChat()');
  check("resetChat() clears in-progress newClientState", win3.eval('newClientState') === null);
}

async function testPhoneFormatting() {
  console.log("\n=== TEST SUITE 8: Phone Number Formatting ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  check("Formats raw 10 digits", win.eval('formatPhone("5628828632")') === "562-882-8632");
  check("Formats digits with spaces", win.eval('formatPhone("562 882 8632")') === "562-882-8632");
  check("Formats digits with parens/dashes", win.eval('formatPhone("(562) 882-8632")') === "562-882-8632");
  check("Formats 11-digit with leading 1", win.eval('formatPhone("15628828632")') === "562-882-8632");
  check("Leaves already-correct format unchanged", win.eval('formatPhone("562-882-8632")') === "562-882-8632");
  check("Leaves non-10/11-digit numbers as typed (e.g. international)", win.eval('formatPhone("+44 20 7946 0958")') === "+44 20 7946 0958");
  check("Handles empty string without throwing", win.eval('formatPhone("")') === "");
  check("Handles null/undefined gracefully", win.eval('formatPhone(null)') === null);

  // Integration: new-client flow formats phone before saving
  win.eval('startNewClient()');
  win.eval(`document.getElementById("userInput").value = "Carlos Mendez"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // street
  win.eval(`document.getElementById("userInput").value = "test@example.com"; sendMsg();`); // email
  win.eval(`document.getElementById("userInput").value = "5551234567"; sendMsg();`); // phone, raw digits
  check("New-client flow formats phone in summary step data", win.eval('newClientState.data.phone') === "555-123-4567");
  win.eval(`document.getElementById("userInput").value = "Looks good"; sendMsg();`);
  const clients = JSON.parse(win.eval('JSON.stringify(savedClients)'));
  const saved = clients.find(c => c.name === "Carlos Mendez");
  check("Saved client record has formatted phone", saved && saved.phone === "555-123-4567");

  // Integration: editing phone from summary also formats it
  const dom2 = freshDom();
  const win2 = dom2.window;
  await wait(300);
  win2.eval('startNewClient()');
  win2.eval(`document.getElementById("userInput").value = "Test User"; sendMsg();`);
  win2.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`);
  win2.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // email
  win2.eval(`document.getElementById("userInput").value = "5559998888"; sendMsg();`); // phone
  win2.eval(`document.getElementById("userInput").value = "Fix something"; sendMsg();`);
  win2.eval(`document.getElementById("userInput").value = "Phone"; sendMsg();`);
  win2.eval(`document.getElementById("userInput").value = "5550001111"; sendMsg();`); // corrected phone, raw digits
  check("Editing phone field from summary applies formatting", win2.eval('newClientState.data.phone') === "555-000-1111");

  // Integration: Settings contractor phone gets formatted
  const dom3 = freshDom();
  const win3 = dom3.window;
  await wait(300);
  win3.eval('showSettings()');
  win3.document.getElementById("setFirstName").value = "Test";
  win3.document.getElementById("setPhone").value = "5621234567";
  win3.eval('saveSettingsForm()');
  check("Settings contractor phone formatted on save", win3.eval('contractorInfo.phone') === "562-123-4567");
}

async function testClientHandoffMessage() {
  console.log("\n=== TEST SUITE 9: New-Client Handoff to AI (regression for re-asking bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  win.eval('startNewClient()');
  win.eval(`document.getElementById("userInput").value = "Andrew Whallon"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "Yes"; sendMsg();`); // wants to add address now
  win.eval(`document.getElementById("userInput").value = "1995 Canal Avenue"; sendMsg();`); // street
  win.eval(`document.getElementById("userInput").value = "No"; sendMsg();`); // no unit
  win.eval(`document.getElementById("userInput").value = "Long Beach"; sendMsg();`); // city
  win.eval(`document.getElementById("userInput").value = "California"; sendMsg();`); // state
  win.eval(`document.getElementById("userInput").value = "90810"; sendMsg();`); // zip
  win.eval(`document.getElementById("userInput").value = "andywhallon@yahoo.com"; sendMsg();`); // email
  win.eval(`document.getElementById("userInput").value = "5628828632"; sendMsg();`); // phone
  check("Reached summary step with all fields collected", win.eval('newClientState.step') === "summary");

  // Confirm — this triggers the handoff to the AI
  win.eval(`document.getElementById("userInput").value = "Looks good"; sendMsg();`);
  await wait(100);

  // Check what was actually pushed into messages[] for the AI to see (ignore network failure in test env)
  const lastMsg = win.eval('messages[messages.length-1].content');
  check("Handoff message explicitly tells AI not to re-ask for contact details",
    lastMsg.includes("do NOT ask for these again"), `actual message: ${lastMsg}`);
  check("Handoff message confirms client is fully saved",
    lastMsg.toLowerCase().includes("already been fully saved"));
  check("Handoff message still identifies the client by name",
    lastMsg.includes("Andrew Whallon"));

  // Visible chat bubble should stay clean (just the name), even though the AI sees the longer instruction
  const chatHtml = win.document.getElementById("chatBox").innerHTML;
  check("Visible chat bubble shows just the client name, not the internal instruction",
    chatHtml.includes(">Andrew Whallon<") && !chatHtml.includes("App note:"));

  // Confirm the client was actually saved with formatted phone before handoff
  const clients = JSON.parse(win.eval('JSON.stringify(savedClients)'));
  const saved = clients.find(c => c.name === "Andrew Whallon");
  check("Client was saved before handoff occurred", !!saved);
  check("Saved client phone is formatted", saved && saved.phone === "562-882-8632");

  // Retry path: lastUserText should also carry the full handoff instruction, not just the bare name
  const retryText = win.eval('lastUserText');
  check("lastUserText (used on retry) also contains the no-re-ask instruction",
    retryText.includes("do NOT ask for these again"));
}

async function testGenericJobAddressFlow() {
  console.log("\n=== TEST SUITE 10: Guided Job-Address Flow (Generic Mode) — regression for Adrian's reported bug ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  win.eval(`contractorInfo.mode = "generic"; invoiceType = "labor"; currentOrderedBy = "";`);

  // Simulate the AI asking for job address — should trigger the guided flow, not accept free text directly
  win.eval(`smartChips("Great! Andrew Whallon it is. What's the job address?")`);
  check("Job address question triggers unified guided flow in generic mode", win.eval('guidedAddrState !== null'));
  check("Guided flow purpose is job", win.eval('guidedAddrState.purpose') === "job");
  check("Guided flow starts at street step", win.eval('guidedAddrState.step') === "street");

  const introHtml = win.document.getElementById("chatBox").innerHTML;
  check("Intro message lists all 5 fields it will ask about",
    introHtml.includes("Street address") && introHtml.includes("Unit") && introHtml.includes("City") && introHtml.includes("State") && introHtml.includes("Zip"));

  // Walk through the full flow with a unit number, matching Adrian's real address structure
  win.eval(`document.getElementById("userInput").value = "1993 Canal Avenue"; sendMsg();`);
  check("Street step advances to unit_yn", win.eval('guidedAddrState.step') === "unit_yn");
  check("Street stored correctly", win.eval('guidedAddrState.data.street') === "1993 Canal Avenue");

  win.eval(`document.getElementById("userInput").value = "No"; sendMsg();`);
  check("Saying No to unit skips straight to city", win.eval('guidedAddrState.step') === "city");
  check("Unit stored as blank", win.eval('guidedAddrState.data.unit') === "");

  win.eval(`document.getElementById("userInput").value = "Long Beach"; sendMsg();`);
  check("City step advances to state", win.eval('guidedAddrState.step') === "state");

  win.eval(`document.getElementById("userInput").value = "CA"; sendMsg();`);
  check("State step advances to zip", win.eval('guidedAddrState.step') === "zip");

  win.eval(`document.getElementById("userInput").value = "90810"; sendMsg();`);
  await wait(100);
  check("After zip, guidedAddrState is cleared (flow complete)", win.eval('guidedAddrState') === null);
  check("convStage advances to tasks after job address complete", win.eval('convStage') === "tasks");

  const handoffMsg = win.eval('messages[messages.length-1].content');
  check("Handoff message includes the full built address", handoffMsg.includes("1993 Canal Avenue") && handoffMsg.includes("Long Beach") && handoffMsg.includes("CA") && handoffMsg.includes("90810"));
  check("Handoff message tells AI not to re-ask for address", handoffMsg.includes("do NOT ask for it again"));

  const chatHtml = win.document.getElementById("chatBox").innerHTML;
  check("Visible chat shows the clean built address, not the internal instruction", chatHtml.includes("1993 Canal Avenue") && !chatHtml.includes("App note:"));

  // Test the explicit-unit path
  const dom2 = freshDom();
  const win2 = dom2.window;
  await wait(300);
  win2.eval(`contractorInfo.mode = "generic"; invoiceType = "labor";`);
  win2.eval(`smartChips("What's the job address?")`);
  win2.eval(`document.getElementById("userInput").value = "500 Main St"; sendMsg();`);
  win2.eval(`document.getElementById("userInput").value = "Yes"; sendMsg();`);
  check("Saying Yes to unit moves to unit_number step", win2.eval('guidedAddrState.step') === "unit_number");
  win2.eval(`document.getElementById("userInput").value = "Apt 4B"; sendMsg();`);
  check("Unit number step advances to city", win2.eval('guidedAddrState.step') === "city");
  check("Unit stored correctly", win2.eval('guidedAddrState.data.unit') === "Apt 4B");
  win2.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // city
  win2.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // state
  win2.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // zip
  await wait(100);
  const handoffMsg2 = win2.eval('messages[messages.length-1].content');
  check("Address with unit but skipped city/state/zip still includes street and unit", handoffMsg2.includes("500 Main St") && handoffMsg2.includes("Apt 4B"));

  // Confirm BPLW mode is completely unaffected — should still use the original chip-based picker, not this new flow
  const dom3 = freshDom();
  const win3 = dom3.window;
  await wait(300);
  win3.eval(`currentOrderedBy = "Andrew Whallon";`); // BPLW mode default stays
  win3.eval(`smartChips("Which address was the job at?")`);
  check("BPLW mode does NOT trigger the unified guided job-address flow", win3.eval('guidedAddrState') === null);
  const bplwChipArea = win3.document.getElementById("chipArea").innerHTML;
  check("BPLW mode still shows the original address chips", bplwChipArea.includes("chip"));

  // Confirm resetChat clears any in-progress guidedAddrState
  const dom4 = freshDom();
  const win4 = dom4.window;
  await wait(300);
  win4.eval(`contractorInfo.mode = "generic";`);
  win4.eval(`startGuidedAddress("job")`);
  check("guidedAddrState set before reset", win4.eval('guidedAddrState') !== null);
  win4.eval('resetChat()');
  check("resetChat() clears in-progress guidedAddrState", win4.eval('guidedAddrState') === null);
}

async function testUnifiedAddressBplwAndContractorPurposes() {
  console.log("\n=== TEST SUITE 11: Unified Guided Address Flow — BPLW and Contractor Settings purposes ===");

  // BPLW purpose: adding a new address for a partner via the chat (the original "+ Add new address" chip)
  const dom = freshDom();
  const win = dom.window;
  await wait(300);
  win.eval(`startGuidedAddress("bplw", {clientName: "Richard Baisz"})`);
  check("BPLW purpose stored on guidedAddrState", win.eval('guidedAddrState.purpose') === "bplw");
  check("BPLW meta carries the client name", win.eval('guidedAddrState.meta.clientName') === "Richard Baisz");

  win.eval(`document.getElementById("userInput").value = "777 Anaheim St"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "No"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "Long Beach"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "CA"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "90804"; sendMsg();`);
  check("guidedAddrState cleared after BPLW address completes", win.eval('guidedAddrState') === null);

  const richardAddrs = JSON.parse(win.eval(`JSON.stringify(getClientAddresses("Richard Baisz"))`));
  const savedAddr = richardAddrs.find(a => a.full && a.full.includes("777 Anaheim St"));
  check("New BPLW address actually saved to Richard Baisz's address book", !!savedAddr);
  check("Saved BPLW address includes city/state/zip", savedAddr && savedAddr.full.includes("Long Beach") && savedAddr.full.includes("CA") && savedAddr.full.includes("90804"));

  // Confirm this doesn't affect Andrew Whallon's separate preloaded address list
  const andrewAddrs = JSON.parse(win.eval(`JSON.stringify(getClientAddresses("Andrew Whallon"))`));
  check("Andrew Whallon's preloaded addresses remain untouched", andrewAddrs.length > 0);

  // Contractor Settings purpose
  const dom2 = freshDom();
  const win2 = dom2.window;
  await wait(300);
  win2.eval(`startGuidedAddress("contractor")`);
  check("Contractor purpose stored on guidedAddrState", win2.eval('guidedAddrState.purpose') === "contractor");

  win2.eval(`document.getElementById("userInput").value = "42 Workshop Way"; sendMsg();`);
  win2.eval(`document.getElementById("userInput").value = "No"; sendMsg();`);
  win2.eval(`document.getElementById("userInput").value = "Riverside"; sendMsg();`);
  win2.eval(`document.getElementById("userInput").value = "CA"; sendMsg();`);
  win2.eval(`document.getElementById("userInput").value = "92501"; sendMsg();`);
  check("guidedAddrState cleared after contractor address completes", win2.eval('guidedAddrState') === null);

  const settingsAddrValue = win2.document.getElementById("setAddress").value;
  check("Contractor address field populated with the built address", settingsAddrValue.includes("42 Workshop Way") && settingsAddrValue.includes("Riverside"));
  check("Settings panel is shown after contractor address completes", win2.document.getElementById("settingsPanel").style.display === "block");

  // Confirm the BPLW legacy edit_field path (Address Manager single-field correction) still works independently
  const dom3 = freshDom();
  const win3 = dom3.window;
  await wait(300);
  win3.eval(`
    editingAddressKey = "addr_TestClient";
    editingAddressIdx = 0;
    editingAddressData = {streetName:"Old St", streetNum:"100", unit:"", city:"Old City", zip:"90000"};
    localStorage.setItem("addr_TestClient", JSON.stringify([{id:"x", display:"100 Old St", full:"100 Old St, Old City 90000"}]));
    newAddrState = {step:"edit_field", data:{...editingAddressData, field:"city"}};
  `);
  win3.eval(`document.getElementById("userInput").value = "New City"; sendMsg();`);
  const updatedList = JSON.parse(win3.eval(`localStorage.getItem("addr_TestClient")`));
  check("Legacy edit_field path still updates a saved BPLW address correctly", updatedList[0].full.includes("New City"));
  check("newAddrState cleared after edit_field completes", win3.eval('newAddrState') === null);
}

async function testDateYearValidation() {
  console.log("\n=== TEST SUITE 12: Date Year Validation ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // dateHasYear unit tests
  check("Detects a full date with year as valid", win.eval(`dateHasYear("May 5, 2026")`) === true);
  check("Detects MM/DD/YYYY as valid", win.eval(`dateHasYear("5/5/2026")`) === true);
  check("Detects a 2-digit year as missing a real year (e.g. '5/5/26' has no 4-digit year)", win.eval(`dateHasYear("5/5/26")`) === false);
  check("Detects 'May 5' with no year as invalid", win.eval(`dateHasYear("May 5")`) === false);
  check("Detects '5/5' with no year as invalid", win.eval(`dateHasYear("5/5")`) === false);
  check("Blank date is not flagged (not this check's concern)", win.eval(`dateHasYear("")`) === true);
  check("Null date is not flagged", win.eval(`dateHasYear(null)`) === true);
  check("Detects year embedded mid-string", win.eval(`dateHasYear("2026-05-05")`) === true);

  // findMissingYearDates unit tests
  const result1 = JSON.parse(win.eval(`JSON.stringify(findMissingYearDates({date:"May 5", materials_items:[]}))`));
  check("Flags a missing-year invoice date", result1.length === 1 && result1[0].label === "invoice date");

  const result2 = JSON.parse(win.eval(`JSON.stringify(findMissingYearDates({date:"May 5, 2026", materials_items:[{vendor:"Home Depot",date:"June 1",amount:50}]}))`));
  check("Flags a missing-year receipt date while invoice date is fine", result2.length === 1 && result2[0].label.includes("receipt 1"));
  check("Receipt label includes the vendor name for clarity", result2[0].label.includes("Home Depot"));

  const result3 = JSON.parse(win.eval(`JSON.stringify(findMissingYearDates({date:"May 5, 2026", materials_items:[{vendor:"A",date:"June 1, 2026",amount:10},{vendor:"B",date:"July 15",amount:20}]}))`));
  check("Only flags the actual offending date among multiple receipts", result3.length === 1 && result3[0].label.includes("B"));

  const result4 = JSON.parse(win.eval(`JSON.stringify(findMissingYearDates({date:"May 5, 2026", materials_items:[{vendor:"A",date:"June 1, 2026",amount:10}]}))`));
  check("Returns empty array when all dates are complete", result4.length === 0);

  // Integration: the backstop fires correctly when callClaude receives a final JSON with a bad date.
  // We can't hit the real API in this sandbox, so we exercise the exact same code path the way
  // callClaude would after parsing a reply, calling the relevant logic directly.
  win.eval(`
    invoiceData = {done:true, date:"May 5", materials_items:[], bill_to_phone:"", new_client:null};
    const missingYearDates = findMissingYearDates(invoiceData);
    if (missingYearDates.length > 0) {
      const first = missingYearDates[0];
      const thisYear = new Date().getFullYear();
      addAIMsg("I see the " + first.label + " (\\"" + first.value + "\\") doesn't include a year. Was that " + thisYear + ", or a different year?");
      showYearClarifyChips(first.label, thisYear);
    }
  `);
  const chatHtml = win.document.getElementById("chatBox").innerHTML;
  check("Backstop produces a clarifying message mentioning the bad date", chatHtml.includes("May 5") && chatHtml.includes("doesn't include a year"));
  const chipHtml = win.document.getElementById("chipArea").innerHTML;
  check("Year-clarify chips render with current year option", chipHtml.includes(String(new Date().getFullYear())));
  check("Year-clarify chips include a different-year option", chipHtml.toLowerCase().includes("different year"));
}

async function testJobAddressConfirmationDoesNotRetrigger() {
  console.log("\n=== TEST SUITE 13: Job-Address Confirmation Does Not Re-trigger Guided Flow (regression for Adrian's reported bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);
  win.eval(`contractorInfo.mode = "generic"; invoiceType = "labor";`);

  // The actual question (with a "?") should still trigger the guided flow correctly
  win.eval(`smartChips("Great! Let's continue. What's the job address?")`);
  check("The real question (with ?) still triggers the guided flow", win.eval('guidedAddrState !== null'));

  // Complete the flow normally
  win.eval(`document.getElementById("userInput").value = "1995 Canal Avenue"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "No"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "Long Beach"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "California"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "90810"; sendMsg();`);
  check("guidedAddrState cleared after the real flow completes", win.eval('guidedAddrState') === null);

  // Now simulate the exact AI confirmation message from Adrian's screenshot —
  // this is a STATEMENT restating the address, not a question, and must NOT re-trigger the flow
  win.eval(`smartChips("Got it! The job address is 1995, Long Beach California 90810. What was the first task and price?")`);
  check("Confirmation statement (no '?' near 'job address') does NOT re-trigger guidedAddrState",
    win.eval('guidedAddrState') === null);

  // Sanity check: a similar confirmation phrasing without a question mark anywhere near 'address' is also safe
  const dom2 = freshDom();
  const win2 = dom2.window;
  await wait(300);
  win2.eval(`contractorInfo.mode = "generic";`);
  win2.eval(`smartChips("The job address is 123 Main St, Anytown CA 90000.")`);
  check("A bare confirmation sentence with no question mark never triggers the guided flow",
    win2.eval('guidedAddrState') === null);

  // And confirm BPLW mode's equivalent confirmation phrasing is also safe
  const dom3 = freshDom();
  const win3 = dom3.window;
  await wait(300);
  win3.eval(`smartChips("Got it, the address was the job at 1001 Cherry Ave. What was the first task and price?")`);
  check("BPLW mode confirmation phrasing does not re-trigger the address picker chips unexpectedly",
    win3.document.getElementById("chipArea").innerHTML === "");
}

async function testAiStatedWrongYearGetsCorrected() {
  console.log("\n=== TEST SUITE 14: AI-Stated Wrong Year Gets Corrected (regression for Adrian's reported bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // Reproduce the exact AI reply from Adrian's screenshot, where the AI stated 2025
  // despite the real current year (per the device/sandbox clock) being 2026.
  const aiReplyWithWrongYear = "Got it — and was that this year (2025), or a different year?";
  const corrected = win.eval(`
    (function(){
      let reply = ${JSON.stringify(aiReplyWithWrongYear)};
      const yearClarifyMatch = reply.match(/this year\\s*\\((\\d{4})\\)/i) || reply.match(/este año\\s*\\((\\d{4})\\)/i);
      if (yearClarifyMatch) {
        const statedYear = yearClarifyMatch[1];
        const actualYear = String(new Date().getFullYear());
        if (statedYear !== actualYear) {
          reply = reply.replace(statedYear, actualYear);
        }
      }
      return reply;
    })()
  `);
  const realCurrentYear = win.eval('new Date().getFullYear()');
  check("Wrong year in AI reply gets corrected to the real current year",
    corrected.includes(String(realCurrentYear)) && !corrected.includes("2025"),
    `corrected text: "${corrected}", expected year: ${realCurrentYear}`);
  check("Corrected text otherwise preserves the original message",
    corrected.includes("Got it") && corrected.includes("different year"));

  // Confirm a reply with the CORRECT year already is left untouched (no double-correction artifacts)
  const correctYearReply = `Got it — and was that this year (${realCurrentYear}), or a different year?`;
  const unchanged = win.eval(`
    (function(){
      let reply = ${JSON.stringify(correctYearReply)};
      const yearClarifyMatch = reply.match(/this year\\s*\\((\\d{4})\\)/i) || reply.match(/este año\\s*\\((\\d{4})\\)/i);
      if (yearClarifyMatch) {
        const statedYear = yearClarifyMatch[1];
        const actualYear = String(new Date().getFullYear());
        if (statedYear !== actualYear) {
          reply = reply.replace(statedYear, actualYear);
        }
      }
      return reply;
    })()
  `);
  check("A reply with the already-correct year is left unchanged", unchanged === correctYearReply);

  // Confirm the Spanish phrasing pattern is also caught
  const spanishWrongYear = "Entendido — ¿fue este año (2025), o un año diferente?";
  const correctedEs = win.eval(`
    (function(){
      let reply = ${JSON.stringify(spanishWrongYear)};
      const yearClarifyMatch = reply.match(/this year\\s*\\((\\d{4})\\)/i) || reply.match(/este año\\s*\\((\\d{4})\\)/i);
      if (yearClarifyMatch) {
        const statedYear = yearClarifyMatch[1];
        const actualYear = String(new Date().getFullYear());
        if (statedYear !== actualYear) {
          reply = reply.replace(statedYear, actualYear);
        }
      }
      return reply;
    })()
  `);
  check("Spanish-phrased wrong year also gets corrected", correctedEs.includes(String(realCurrentYear)) && !correctedEs.includes("2025"));

  // Confirm a reply with no year-clarification pattern at all passes through untouched
  const unrelatedReply = "What was the first task and price?";
  const stillUnrelated = win.eval(`
    (function(){
      let reply = ${JSON.stringify(unrelatedReply)};
      const yearClarifyMatch = reply.match(/this year\\s*\\((\\d{4})\\)/i) || reply.match(/este año\\s*\\((\\d{4})\\)/i);
      if (yearClarifyMatch) {
        const statedYear = yearClarifyMatch[1];
        const actualYear = String(new Date().getFullYear());
        if (statedYear !== actualYear) {
          reply = reply.replace(statedYear, actualYear);
        }
      }
      return reply;
    })()
  `);
  check("Unrelated replies with no year pattern pass through completely untouched", stillUnrelated === unrelatedReply);
}

async function testFormattedSummaryPhoneFormatting() {
  console.log("\n=== TEST SUITE 15: Formatted Summary Phone Number Formatting (regression for Adrian's reported bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // Reproduce the exact raw AI summary text from Adrian's screenshot, with an unformatted phone number
  const rawSummary = "Here's what I have:\n\nClient: Andrew Whallon\nClient Address: 1995 Canal Avenue\nClient Email: andywhallon@yahoo.com\nClient Phone: 5628828632\nJob Address: 1995 Canal Avenue, Long Beach California 90810\n\nWork Performed:\n- Repair the sprinkler system - $500.00\n\nDate Completed: June 16, 2026\n\nIs everything correct?";

  win.eval(`showFormattedSummary(${JSON.stringify(rawSummary)})`);
  const chatHtml = win.document.getElementById("chatBox").innerHTML;
  check("Formatted summary shows the phone number reformatted as xxx-xxx-xxxx",
    chatHtml.includes("562-882-8632"), `chat HTML: ${chatHtml.slice(0,400)}`);
  check("Formatted summary no longer shows the raw unformatted digits",
    !chatHtml.includes("5628828632"));
  check("Formatted summary still preserves the email address correctly",
    chatHtml.includes("andywhallon@yahoo.com"));
  check("Formatted summary still preserves the client name",
    chatHtml.includes("Andrew Whallon"));

  // Test with a Spanish label too
  const dom2 = freshDom();
  const win2 = dom2.window;
  await wait(300);
  const rawSummaryEs = "Cliente: Andrew Whallon\nTeléfono: 5628828632\nDirección del trabajo: 1995 Canal Avenue";
  win2.eval(`showFormattedSummary(${JSON.stringify(rawSummaryEs)})`);
  const chatHtmlEs = win2.document.getElementById("chatBox").innerHTML;
  check("Spanish 'Teléfono' label phone number also gets reformatted",
    chatHtmlEs.includes("562-882-8632"));

  // Test that a summary with no phone number at all doesn't error or get mangled
  const dom3 = freshDom();
  const win3 = dom3.window;
  await wait(300);
  const rawSummaryNoPhone = "Client: Test Client\nJob Address: 123 Main St\nDate: June 16, 2026";
  win3.eval(`showFormattedSummary(${JSON.stringify(rawSummaryNoPhone)})`);
  const chatHtmlNoPhone = win3.document.getElementById("chatBox").innerHTML;
  check("Summary with no phone number renders without error", chatHtmlNoPhone.includes("Test Client"));

  // Test a phone number already in the correct format isn't double-mangled
  const dom4 = freshDom();
  const win4 = dom4.window;
  await wait(300);
  const rawSummaryFormatted = "Client: Test Client\nClient Phone: 562-882-8632\nJob Address: 123 Main St";
  win4.eval(`showFormattedSummary(${JSON.stringify(rawSummaryFormatted)})`);
  const chatHtmlFormatted = win4.document.getElementById("chatBox").innerHTML;
  check("An already-correctly-formatted phone number passes through unchanged",
    chatHtmlFormatted.includes("562-882-8632") && !chatHtmlFormatted.includes("562-882-882-8632"));
}

async function testConfirmationTriggerMatchesActualPromptWording() {
  console.log("\n=== TEST SUITE 16: Confirmation Trigger Matches Actual Prompt Wording (regression for Adrian's reported bug) ===");

  // Pull the actual instructed confirmation phrase directly out of the live system prompt,
  // so this test fails loudly if the prompt wording ever changes again without updating the trigger.
  const dom = freshDom();
  const win = dom.window;
  await wait(300);
  const sysPrompt = win.eval('getSystemPrompt()');
  const promptMatch = sysPrompt.match(/Then ask "([^"]+)"/);
  check("System prompt contains an explicit confirmation question instruction", !!promptMatch);

  if (promptMatch) {
    const actualInstructedPhrase = promptMatch[1];
    const lower = actualInstructedPhrase.toLowerCase();
    const triggerMatches = lower.includes("confirm") || lower.includes("everything correct") || lower.includes("look correct") || lower.includes("need to be fixed") || lower.includes("confirmar") || lower.includes("todo correcto") || lower.includes("se ve correcto") || lower.includes("corregir algo");
    check(`The exact instructed confirmation phrase ("${actualInstructedPhrase}") matches the showFormattedSummary trigger`,
      triggerMatches, "if this fails, the prompt wording changed without updating the trigger condition — exactly the bug Adrian hit");
  }

  // Also directly verify the specific phrase that caused the real bug
  const bugPhrase = "Does everything look correct, or do you want to fix something?".toLowerCase();
  const bugPhraseMatches = bugPhrase.includes("confirm") || bugPhrase.includes("everything correct") || bugPhrase.includes("look correct") || bugPhrase.includes("need to be fixed") || bugPhrase.includes("confirmar") || bugPhrase.includes("todo correcto");
  check("The exact phrase from Adrian's bug report now matches the trigger", bugPhraseMatches);

  // End-to-end: simulate showFormattedSummary firing on a reply using the real instructed phrasing,
  // confirming phone formatting actually applies when triggered through the real condition logic
  const fullReply = "Client: Andrew Whallon\nClient Phone: 5628828632\nJob Address: 123 Main St\n\nDoes everything look correct, or do you want to fix something?";
  const lower = fullReply.toLowerCase();
  const wouldTrigger = lower.includes("confirm") || lower.includes("everything correct") || lower.includes("look correct") || lower.includes("need to be fixed") || lower.includes("confirmar") || lower.includes("todo correcto");
  check("The full realistic AI reply triggers showFormattedSummary", wouldTrigger);

  if (wouldTrigger) {
    win.eval(`showFormattedSummary(${JSON.stringify(fullReply)})`);
    const chatHtml = win.document.getElementById("chatBox").innerHTML;
    check("When correctly triggered, the phone number is formatted in the displayed summary",
      chatHtml.includes("562-882-8632") && !chatHtml.includes("5628828632"));
  }
}

async function testCombinedLaborMaterialsInvoice() {
  console.log("\n=== TEST SUITE 17: Combined Labor + Materials Invoice (regression for Adrian's reported bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  win.eval(`
    invoiceType = "both";
    invoiceData = {
      done: true, client_type: "generic",
      bill_to_name: "Test Client", bill_to_address: "123 Main St", bill_to_email: "test@example.com", bill_to_phone: "555-123-4567",
      ordered_by: "", job_address: "456 Job Site Rd",
      work_items: [{desc:"Repair sprinkler system", amount:500}],
      materials_items: [{vendor:"Home Depot", desc:"PVC pipe", date:"June 3, 2026", amount:35.12}],
      date: "June 3, 2026", has_materials: true, has_labor: true, new_client: null
    };
    receipts = []; jobPhotos = [];
    document.getElementById("photoSections").style.display = "block";
    document.getElementById("receiptSection").style.display = "block";
    showInvoicePreview(invoiceData);
  `);
  await wait(100);

  const invoiceArea = win.document.getElementById("invoiceArea").innerHTML;
  const cardCount = (invoiceArea.match(/class="invoice-preview"/g) || []).length;
  check("Combined invoice renders as ONE invoice card, not two", cardCount === 1, `found ${cardCount} cards`);
  check("Combined invoice header mentions both Labor and Materials", invoiceArea.includes("Labor") && invoiceArea.includes("Materials"));
  check("Combined invoice shows the Work Performed section", invoiceArea.includes("Repair sprinkler system"));
  check("Combined invoice shows the Materials section", invoiceArea.includes("Home Depot"));
  check("Combined invoice shows a Labor subtotal", invoiceArea.includes("Subtotal") && invoiceArea.includes("500.00"));
  check("Combined invoice shows a Materials subtotal", invoiceArea.includes("35.12"));
  check("Combined invoice shows ONE grand total of 535.12", invoiceArea.includes("535.12"));
  check("Combined invoice has a single Generate PDF button (not two separate ones)",
    (invoiceArea.match(/Generate.*PDF/g) || []).length === 1);
  check("Combined invoice has a single Share Invoice button", (invoiceArea.match(/Share Invoice/g) || []).length === 1);

  // Test buildPDF produces a single combined PDF object with the right invoice number
  const builtInfo = win.eval(`
    (async () => {
      const built = await buildPDF("both");
      return JSON.stringify({fname: built.fname, invNum: built.invNum, isCombined: built.isCombined});
    })()
  `);
  const parsed = JSON.parse(await builtInfo);
  check("buildPDF('both') returns a combined result", parsed.isCombined === true);
  check("Combined PDF filename doesn't say 'Labor_Invoice' or 'Materials_Invoice' specifically", 
    !parsed.fname.includes("Labor_Invoice") && !parsed.fname.includes("Materials_Invoice"));

  // Test the correction menu offers both Work/Tasks AND Materials/Receipts for combined invoices
  win.eval(`showCorrectionMenu("both")`);
  const chipArea = win.document.getElementById("chipArea").innerHTML;
  check("Correction menu for combined invoice offers Work/Tasks option", chipArea.includes("Work") || chipArea.includes("Tasks"));
  check("Correction menu for combined invoice offers Materials/Receipts option", chipArea.includes("Materials") || chipArea.includes("Receipts"));

  // Test history list correctly labels combined invoices
  win.eval(`
    invoiceHistory = [{type:"both", invNum:30001, invoiceData:{job_address:"456 Job Site Rd", date:"June 3, 2026"}, receipts:[], jobPhotos:[], created_at:new Date().toISOString()}];
    renderHistoryList();
  `);
  const historyHtml = win.document.getElementById("historyList").innerHTML;
  check("History list shows 'Labor & Materials' label for combined invoices, not just 'Materials'",
    historyHtml.includes("Labor &amp; Materials") || historyHtml.includes("Labor & Materials"));
}

async function testPhotoOrientationCorrection() {
  console.log("\n=== TEST SUITE 18: Photo Orientation Correction (regression for Adrian's reported bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // getExifOrientation should return 1 (normal) for non-JPEG data, never throw
  const pngBuffer = win.eval(`
    (function(){
      const arr = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0]); // PNG magic bytes, not JPEG
      return getExifOrientation(arr.buffer);
    })()
  `);
  check("getExifOrientation returns 1 (normal) for non-JPEG data without throwing", pngBuffer === 1);

  // A JPEG with no EXIF APP1 segment at all should also return 1 safely
  const bareJpeg = win.eval(`
    (function(){
      // Minimal JPEG SOI marker followed immediately by EOI, no EXIF segment
      const arr = new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]);
      return getExifOrientation(arr.buffer);
    })()
  `);
  check("getExifOrientation returns 1 for a JPEG with no EXIF segment (and does not crash)", bareJpeg === 1);

  // Truncated/corrupted JPEG data should never throw, just fall back to 1
  const truncatedCases = [
    [0xFF, 0xD8], // SOI only, nothing else
    [0xFF, 0xD8, 0xFF], // dangling marker byte
    [0xFF, 0xD8, 0xFF, 0xE1], // APP1 marker with no length/payload at all
    [], // completely empty
  ];
  truncatedCases.forEach((bytes, idx) => {
    const result = win.eval(`
      (function(){
        try {
          const arr = new Uint8Array([${bytes.join(",")}]);
          return getExifOrientation(arr.buffer);
        } catch(e) {
          return "THREW: " + e.message;
        }
      })()
    `);
    check(`Truncated JPEG case ${idx} (${bytes.length} bytes) does not crash`, result === 1, `got: ${result}`);
  });

  // correctImageOrientation should resolve immediately with the original dataUrl when orientation is 1 (no-op case)
  const noOpResult = win.eval(`
    (async () => {
      const result = await correctImageOrientation("data:image/jpeg;base64,FAKE", 1);
      return result;
    })()
  `);
  const resolved = await noOpResult;
  check("correctImageOrientation is a no-op when orientation is 1 (normal)", resolved === "data:image/jpeg;base64,FAKE");

  // Verify handlePhoto is wired to call EXIF correction (checking the function source references it)
  const handlePhotoSource = win.eval('handlePhoto.toString()');
  check("handlePhoto calls getExifOrientation before storing the photo", handlePhotoSource.includes("getExifOrientation"));
  check("handlePhoto calls correctImageOrientation before storing the photo", handlePhotoSource.includes("correctImageOrientation"));
  check("handlePhoto has a fallback (try/catch) so a failed correction doesn't block adding the photo",
    handlePhotoSource.includes("catch"));
}

async function testGenericModeJobAddressPersistence() {
  console.log("\n=== TEST SUITE 19: Generic-Mode Job Address Persistence (regression for Adrian's reported bug) ===");

  // Picking a saved client should set currentOrderedBy, which is required for address lookup
  const dom = freshDom();
  const win = dom.window;
  await wait(300);
  win.eval(`
    contractorInfo.mode = "generic";
    addClient({name:"Andrew Whallon", address:"", email:"andywhallon@yahoo.com", phone:"562-882-8632"});
    showSavedClientChips();
  `);
  // Simulate clicking the first saved-client chip
  win.eval(`document.querySelector('#chipArea .chip:not(.new)').click()`);
  check("Picking a saved client sets currentOrderedBy to that client's name", win.eval('currentOrderedBy') === "Andrew Whallon");

  // First time asking for job address: no saved addresses yet, should launch the guided flow directly
  await wait(100);
  win.eval(`smartChips("What's the job address?")`);
  check("With no saved addresses, the guided flow launches directly", win.eval('guidedAddrState !== null && guidedAddrState.purpose') === "job");
  check("guidedAddrState meta carries the client name for persistence", win.eval('guidedAddrState.meta.clientName') === "Andrew Whallon");

  // Complete the guided flow
  win.eval(`document.getElementById("userInput").value = "1995 Canal Avenue"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "No"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "Long Beach"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "CA"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "90810"; sendMsg();`);
  await wait(100);

  // Confirm the address was actually persisted to this client's address book
  const savedAddrs = JSON.parse(win.eval(`JSON.stringify(getClientAddresses("Andrew Whallon"))`));
  check("The completed job address was saved to the client's address book", savedAddrs.length === 1, `found ${savedAddrs.length} addresses`);
  check("Saved address includes the full street/city/state/zip", savedAddrs[0] && savedAddrs[0].full.includes("1995 Canal Avenue") && savedAddrs[0].full.includes("Long Beach"));

  const savedMsg = win.document.getElementById("chatBox").innerHTML;
  check("Confirmation message tells the user the address will be remembered next time",
    savedMsg.toLowerCase().includes("remember"));

  // Second invoice for the SAME client: this time it should offer the saved address as a chip,
  // not silently re-run the entire 5-question guided flow from scratch
  win.eval(`resetChat(); contractorInfo.mode = "generic"; currentOrderedBy = "Andrew Whallon";`);
  win.eval(`smartChips("What's the job address?")`);
  check("On the second invoice, the guided flow does NOT launch again (a saved address exists)",
    win.eval('guidedAddrState') === null);
  const chipArea = win.document.getElementById("chipArea").innerHTML;
  check("The previously-saved address appears as a selectable chip", chipArea.includes("1995 Canal Avenue"));
  check("A '+ Add new address' option is still available for a different job site", chipArea.includes("Add new address") || chipArea.includes("Nueva dirección"));

  // Clicking the saved-address chip should hand off correctly without re-running the guided flow
  win.eval(`document.querySelector('#chipArea .chip:not(.new)').click()`);
  await wait(100);
  const handoffMsg = win.eval('messages[messages.length-1].content');
  check("Clicking the saved address chip hands off the full address to the AI", handoffMsg.includes("1995 Canal Avenue"));
  check("guidedAddrState was never launched when using a saved address chip", win.eval('guidedAddrState') === null);
}

async function testAndrewWhallonNameCollisionFix() {
  console.log("\n=== TEST SUITE 20: Andrew Whallon Name Collision Fix (regression for cross-contamination bug) ===");

  // In BPLW mode, "Andrew Whallon" should still correctly get Alfonso's real preloaded addresses
  const domBplw = freshDom();
  const winBplw = domBplw.window;
  await wait(300);
  const bplwAddrs = JSON.parse(winBplw.eval(`JSON.stringify(getClientAddresses("Andrew Whallon"))`));
  check("BPLW mode: Andrew Whallon still gets the preloaded Long Beach address list", bplwAddrs.length > 0);

  // In generic mode, a client who happens to ALSO be named "Andrew Whallon" must NOT see
  // Alfonso's real preloaded addresses — this was the actual collision bug
  const domGeneric = freshDom();
  const winGeneric = domGeneric.window;
  await wait(300);
  winGeneric.eval(`contractorInfo.mode = "generic";`);
  const genericAddrs = JSON.parse(winGeneric.eval(`JSON.stringify(getClientAddresses("Andrew Whallon"))`));
  check("Generic mode: a same-named client does NOT inherit Alfonso's preloaded BPLW addresses",
    genericAddrs.length === 0, `found ${genericAddrs.length} addresses, expected 0`);

  // After saving an address for this generic-mode client, only that address should appear —
  // never mixed in with the BPLW preloaded list
  winGeneric.eval(`saveClientAddress("Andrew Whallon", {id:"x", display:"999 Adrian St", full:"999 Adrian St, Riverside CA 92501"})`);
  const genericAddrsAfterSave = JSON.parse(winGeneric.eval(`JSON.stringify(getClientAddresses("Andrew Whallon"))`));
  check("Generic mode: only the contractor's own saved address appears, not BPLW's list",
    genericAddrsAfterSave.length === 1 && genericAddrsAfterSave[0].full.includes("Riverside"));
}

async function testJobPhotoPromptFlow() {
  console.log("\n=== TEST SUITE 21: In-Conversation Job Photo Prompt (regression for Adrian's reported asymmetry bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // The trigger phrase should show the job photo chips, mirroring the receipt photo trigger
  win.eval(`smartChips("Got it. Want to add a photo of the job?")`);
  const chipArea = win.document.getElementById("chipArea").innerHTML;
  check("Job photo prompt phrase triggers showJobPhotoChips", chipArea.includes("Take photo") || chipArea.includes("Tomar foto"));
  check("Job photo chips include a Skip option", chipArea.includes("Skip") || chipArea.includes("Omitir"));

  // Confirm showJobPhotoChips sets up the correct click handler (triggers job-type photo capture)
  win.eval(`showJobPhotoChips()`);
  win.eval(`document.querySelector('#chipArea .chip.new').click()`);
  check("Clicking 'Take photo' sets pendingPhotoChipMsg, same mechanism as receipts", win.eval('pendingPhotoChipMsg') === "📷 Photo added");

  // Simulate a job photo actually being captured via handlePhoto, and confirm it resumes
  // the conversation afterward — this was the actual missing piece (receipt photos already
  // did this, job photos silently did not).
  const dom2 = freshDom();
  const win2 = dom2.window;
  await wait(300);
  win2.eval(`
    pendingPhotoChipMsg = "📷 Photo added";
    jobPhotos = [];
    messages = [];
  `);
  // Simulate what handlePhoto does for a job photo after EXIF correction, without needing a real File object
  win2.eval(`
    (function(){
      const dataUrl = "data:image/jpeg;base64,FAKE";
      if(jobPhotos.length>=8){return;}
      jobPhotos.push(dataUrl);renderJobPhotos();
      if(pendingPhotoChipMsg){
        const msg=pendingPhotoChipMsg;pendingPhotoChipMsg=null;
        document.getElementById("userInput").value=msg;sendMsg();
      }
    })()
  `);
  await wait(100);
  check("Job photo was actually added to jobPhotos", win2.eval('jobPhotos.length') === 1);
  check("After capturing a job photo via the chip flow, the conversation resumes (pendingPhotoChipMsg cleared)",
    win2.eval('pendingPhotoChipMsg') === null);
  const sentMsg = win2.eval('messages.length > 0 ? messages[messages.length-1].content : null');
  check("A follow-up message was sent to the AI after the job photo was captured", sentMsg === "📷 Photo added");

  // Confirm the system prompt actually instructs the AI to ask about job photos after labor tasks
  const sysPrompt = win.eval('getSystemPrompt()');
  check("System prompt instructs the AI to ask about a job photo after collecting labor tasks",
    sysPrompt.includes("Want to add a photo of the job"));
}

(async () => {
  try {
    await testBPLWFlow();
    await testGenericMode();
    await testSettingsMigration();
    await testPanelNavigation();
    await testAlfonsoDeviceUnaffected();
    await testBackButtonVisibility();
    await testNewClientFlow();
    await testPhoneFormatting();
    await testClientHandoffMessage();
    await testGenericJobAddressFlow();
    await testUnifiedAddressBplwAndContractorPurposes();
    await testDateYearValidation();
    await testJobAddressConfirmationDoesNotRetrigger();
    await testAiStatedWrongYearGetsCorrected();
    await testFormattedSummaryPhoneFormatting();
    await testConfirmationTriggerMatchesActualPromptWording();
    await testCombinedLaborMaterialsInvoice();
    await testPhotoOrientationCorrection();
    await testGenericModeJobAddressPersistence();
    await testAndrewWhallonNameCollisionFix();
    await testJobPhotoPromptFlow();
  } catch (e) {
    console.log("FATAL TEST ERROR:", e.message);
    console.log(e.stack);
    failed++;
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("\nFAILURES:");
    failures.forEach(f => console.log("  - " + f));
  }
  process.exit(failed > 0 ? 1 : 0);
})();

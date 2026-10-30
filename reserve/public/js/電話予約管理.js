(() => {
  const form = document.querySelector("#phoneForm");
  if (!form) return;

  const field = (id) => document.getElementById(id);
  let availability = null;
  let loading = false;
  let submitting = false;
  let requestKey = null;
  let loadSequence = 0;

  function error(message = "") {
    field("phoneError").textContent = message;
  }

  function selectedOptions() {
    const ids = new Set([...field("phoneOptions").querySelectorAll("input:checked")].map((input) => input.value));
    return (availability?.options || []).filter((option) => ids.has(option.id));
  }

  function price() {
    const count = Number(field("phoneGuests").value);
    const tier = availability?.tiers?.find((item) => count >= item.min && count <= item.max);
    if (!tier) return null;
    return Number(tier.price) + selectedOptions().reduce(
      (total, option) => total + (option.isRequestOnly ? 0 : Number(option.price)), 0,
    );
  }

  function renderPrice() {
    const total = price();
    field("phoneTotal").textContent = total === null
      ? "合計：人数を選択してください"
      : `合計：${yen(total)}（税込・現地決済）`;
  }

  function slotAvailable(slot, date) {
    const key = `${date}_${slot.id}`;
    return !availability.bookedSlots?.includes(key)
      && !availability.blocks?.some((block) => block.date === date && block.slotId === slot.id)
      && new Date(`${date}T${slot.start}:00+09:00`) > new Date();
  }

  function refreshOptionDeadlines() {
    const date = field("phoneDate").value;
    const slot = availability?.slots?.find((item) => item.id === field("phoneSlot").value);
    const start = slot ? new Date(`${date}T${slot.start}:00+09:00`) : null;
    for (const input of field("phoneOptions").querySelectorAll("input[data-lead-days]")) {
      const days = Number(input.dataset.leadDays);
      const tooLate = start && days > 0 && start < new Date(Date.now() + days * 86400000);
      input.disabled = Boolean(tooLate);
      if (tooLate) input.checked = false;
      input.closest("label").querySelector(".phone-deadline").textContent = tooLate ? "（受付期限を過ぎました）" : "";
    }
    renderPrice();
  }

  async function loadAvailability() {
    const date = field("phoneDate").value;
    const sequence = ++loadSequence;
    availability = null;
    loading = true;
    error();
    field("phoneSlot").innerHTML = '<option value="">空き枠を確認中…</option>';
    field("phoneSlot").disabled = true;
    field("phoneGuests").innerHTML = '<option value="">料金を確認中…</option>';
    field("phoneGuests").disabled = true;
    field("phoneOptions").textContent = "確認中…";
    renderPrice();
    if (!date) {
      loading = false;
      field("phoneSlot").innerHTML = '<option value="">先に利用日を選択してください</option>';
      field("phoneOptions").textContent = "利用日を選ぶと表示されます。";
      return;
    }
    try {
      const data = await apiPost("/reserve/api/reservations", "listAvailability", { from: date, to: date });
      if (sequence !== loadSequence) return;
      availability = data;
      if (data.maxBookableDate) field("phoneDate").max = data.maxBookableDate;
      const openSlots = (data.slots || []).filter((slot) => slotAvailable(slot, date));
      field("phoneSlot").innerHTML = '<option value="">時間枠を選択</option>' + openSlots
        .map((slot) => `<option value="${esc(slot.id)}">${esc(slot.label)}</option>`).join("");
      field("phoneSlot").disabled = !openSlots.length;
      if (!openSlots.length) error("この日は予約できる時間枠がありません。別の日を選択してください。");

      const tiers = (data.tiers || []).flatMap((tier) => Array.from(
        { length: tier.max - tier.min + 1 }, (_, index) => ({ count: tier.min + index, price: tier.price }),
      ));
      field("phoneGuests").innerHTML = '<option value="">人数を選択</option>' + tiers
        .map((tier) => `<option value="${tier.count}">${tier.count}名 / ${yen(tier.price)}</option>`).join("");
      field("phoneGuests").disabled = !tiers.length;
      field("phoneOptions").innerHTML = data.options?.length ? data.options.map((option) => `
        <label class="phone-option">
          <input type="checkbox" value="${esc(option.id)}" data-lead-days="${Number(option.leadTimeDays || 0)}">
          <span>${esc(option.name)}<small class="phone-deadline"></small></span>
          <span>${option.isRequestOnly ? "料金は別途ご案内" : yen(option.price)}</span>
        </label>`).join("") : "事前オプションはありません。";
      refreshOptionDeadlines();
    } catch (failure) {
      if (sequence !== loadSequence) return;
      error(failure.response?.message || "空き状況を取得できませんでした。日付を選び直してください。");
      field("phoneOptions").textContent = "空き状況を読み込めませんでした。";
    } finally {
      if (sequence === loadSequence) {
        loading = false;
        renderPrice();
      }
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    error();
    field("phoneResult").classList.add("hidden");
    const button = field("phoneSubmit");
    try {
      const date = field("phoneDate").value;
      const slotId = field("phoneSlot").value;
      const slot = availability?.slots?.find((item) => item.id === slotId);
      const count = Number(field("phoneGuests").value);
      const name = field("phoneName").value.trim();
      const phone = field("phoneNumber").value.trim();
      const email = field("phoneEmail").value.trim();
      const total = price();
      if (loading || !slot || !slotAvailable(slot, date)) throw new Error("空き枠を選び直してください。");
      if (!count || !name || !phone || total === null) throw new Error("必須項目を入力してください。");
      const options = selectedOptions();
      const summary = `${name}様\n${dayLabel(date)} ${slot.label} / ${count}名\n`
        + (options.length ? `オプション：${options.map((option) => option.name).join("、")}\n` : "")
        + `料金 ${yen(total)}\n${email ? "確認メールを送信します。" : "メール未入力のため確認メールは送信しません。"}`
        + "\n\nこの内容で電話予約を確定しますか？";
      if (!await askConfirm(summary, { okLabel: "予約を登録する", go: true })) return;
      setButtonBusy(button, true, "登録中…");
      requestKey ||= crypto.randomUUID();
      const result = await apiPost("/reserve/api/admin-reservations", "createPhoneBooking", {
        idempotencyKey: requestKey,
        date,
        slotId,
        guestCount: count,
        name,
        phone,
        email,
        kana: field("phoneKana").value.trim(),
        prefectureCode: field("phonePrefecture").value || null,
        referralSource: field("phoneReferral").value || null,
        options: options.map((option) => ({ id: option.id, quantity: 1 })),
        note: field("phoneNote").value.trim(),
        agreedTerms: field("phoneTerms").checked,
        hasMinor: field("phoneMinor").checked,
        guardianConfirmed: field("phoneMinor").checked,
      });
      field("phoneResult").innerHTML = `<b>予約番号 ${esc(result.reservationCode)}</b><br>`
        + `${esc(result.date)} ${esc(result.slot)} / ${result.guestCount}名 / ${yen(result.totalPrice)}<br>`
        + (result.confirmationEmailRequested ? "確認メールの送信を受け付けました。" : "確認メールはありません。予約番号を電話でお伝えください。");
      field("phoneResult").classList.remove("hidden");
      form.reset();
      availability = null;
      requestKey = null;
      loadAvailability();
      loadAll();
      field("phoneResult").scrollIntoView({ block: "start", behavior: "smooth" });
    } catch (failure) {
      const message = failure.response?.message || failure.message || "登録に失敗しました。もう一度お試しください。";
      if (failure.status === 409) await loadAvailability();
      error(message);
    } finally {
      submitting = false;
      setButtonBusy(button, false);
    }
  }

  field("phoneDate").min = todayKey();
  field("phonePrefecture").innerHTML = prefectureSelectHtml("");
  field("phoneReferral").innerHTML = referralSelectHtml("");
  field("phoneDate").addEventListener("change", loadAvailability);
  field("phoneSlot").addEventListener("change", refreshOptionDeadlines);
  field("phoneGuests").addEventListener("change", renderPrice);
  field("phoneOptions").addEventListener("change", renderPrice);
  form.addEventListener("input", () => { if (!submitting) requestKey = null; });
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => field("phone").classList.toggle("hidden", button.dataset.tab !== "phone"));
  });
  form.addEventListener("submit", submit);
})();

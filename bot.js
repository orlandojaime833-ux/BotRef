// ═══════════════════════════════════════════════════════════════
//  TaskMarket Bot — xRocket Payments + Inline Buttons
//  node bot.js
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

// ── Clientes ────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const XROCKET_TOKEN = process.env.XROCKET_TOKEN;        // ex: 2b95ea2ad1f9a2d53563a05d4
const XROCKET_API   = 'https://pay.xrocket.tg';
const TON_TO_TON    = parseFloat(process.env.TON_TO_TON || '1.1');

// ── Estado em memória (wizard de criação de tarefa) ─────────────
const wizards = {}; // chatId → { step, data }

// ════════════════════════════════════════════════════════════════
//  HELPERS — xRocket API
// ════════════════════════════════════════════════════════════════
async function xrocketPost(path, body) {
  const res = await fetch(`${XROCKET_API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Rocket-Pay-Key': XROCKET_TOKEN,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function xrocketGet(path) {
  const res = await fetch(`${XROCKET_API}${path}`, {
    headers: { 'Rocket-Pay-Key': XROCKET_TOKEN },
  });
  return res.json();
}

/** Cria invoice xRocket e devolve { invoice_id, pay_url } */
async function createInvoice(amountTon, description, payload) {
  const body = {
    currency: 'TONCOIN',
    amount: amountTon,
    description,
    payload,
    expiredIn: 3600, // 1h em segundos
  };
  const data = await xrocketPost('/tg-invoices', body);
  if (!data.success) throw new Error(data.message || 'xRocket invoice error');
  return {
    invoice_id: data.data.id,
    pay_url:    data.data.link,
  };
}

/** Verifica status de invoice xRocket */
async function getInvoiceStatus(invoice_id) {
  const data = await xrocketGet(`/tg-invoices/${invoice_id}`);
  if (!data.success) return null;
  return data.data.status; // 'active' | 'paid' | 'expired'
}

/** Transferência TON via xRocket para um utilizador Telegram */
async function transferToUser(telegramUserId, amountTon, description) {
  const data = await xrocketPost('/transfers', {
    tgUserId: telegramUserId,
    currency: 'TONCOIN',
    amount: amountTon,
    transferId: `tx_${Date.now()}_${telegramUserId}`,
    description,
  });
  return data.success;
}

// ════════════════════════════════════════════════════════════════
//  HELPERS — Supabase
// ════════════════════════════════════════════════════════════════
async function getOrCreateUser(telegramId, username, referredBy = null) {
  let { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', String(telegramId))
    .single();

  if (!user) {
    const insert = { telegram_id: String(telegramId), username };
    if (referredBy) {
      const { data: referrer } = await supabase
        .from('users').select('id').eq('telegram_id', String(referredBy)).single();
      if (referrer) {
        insert.referred_by = referrer.id;
        // Credita 0.01 TON ao referenciador
        await supabase.rpc('credit_referral', { referrer_row_id: referrer.id, new_telegram: String(telegramId) })
          .catch(() => null); // função opcional
        // fallback manual
        await supabase.from('users')
          .update({ ton_balance: supabase.rpc('ton_balance + 0.01'), referral_count: supabase.rpc('referral_count + 1') })
          .eq('id', referrer.id).catch(() => null);
        await supabase.from('users').update({
          ton_balance: supabase.raw('ton_balance + 0.01'),
          referral_count: supabase.raw('referral_count + 1'),
        }).eq('id', referrer.id).catch(() => null);
        // simples
        const { data: ref } = await supabase.from('users').select('ton_balance,referral_count').eq('id', referrer.id).single();
        if (ref) {
          await supabase.from('users').update({
            ton_balance: (parseFloat(ref.ton_balance) + 0.01).toFixed(6),
            referral_count: ref.referral_count + 1,
          }).eq('id', referrer.id);
          await supabase.from('referrals').insert({
            referrer_id: referrer.id,
            referred_telegram: String(telegramId),
            ton_credited: 0.01,
          });
        }
      }
    }
    const { data: newUser } = await supabase.from('users').insert(insert).select().single();
    user = newUser;
  }
  return user;
}

async function getUser(telegramId) {
  const { data } = await supabase.from('users').select('*').eq('telegram_id', String(telegramId)).single();
  return data;
}

// ════════════════════════════════════════════════════════════════
//  TECLADO PRINCIPAL
// ════════════════════════════════════════════════════════════════
function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: '➕ Criar Tarefa', callback_data: 'menu_create' }, { text: '📋 Ver Tarefas', callback_data: 'menu_tasks' }],
      [{ text: '💰 Depositar', callback_data: 'menu_deposit' },   { text: '💼 Meu Perfil', callback_data: 'menu_profile' }],
      [{ text: '👥 Referências', callback_data: 'menu_referral' }],
    ],
  };
}

function backBtn(data = 'menu_back') {
  return { inline_keyboard: [[{ text: '⬅️ Voltar', callback_data: data }]] };
}

// ════════════════════════════════════════════════════════════════
//  /start
// ════════════════════════════════════════════════════════════════
bot.onText(/\/start(?:\s+(\d+))?/, async (msg, match) => {
  const chatId   = msg.chat.id;
  const userId   = msg.from.id;
  const username = msg.from.username || msg.from.first_name;
  const refId    = match && match[1] ? match[1] : null;

  await getOrCreateUser(userId, username, refId);

  await bot.sendMessage(chatId,
    `👋 Bem-vindo ao *TaskMarket*, ${username}!\n\n` +
    `Aqui podes:\n` +
    `• 📢 *Publicar tarefas* e pagar executores\n` +
    `• ✅ *Completar tarefas* e ganhar €\n` +
    `• 💎 *Ganhar TON* por referências\n\n` +
    `Usa o menu abaixo para começar:`,
    { parse_mode: 'Markdown', reply_markup: mainMenu() }
  );
});

// ════════════════════════════════════════════════════════════════
//  CALLBACK QUERIES (botões inline)
// ════════════════════════════════════════════════════════════════
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data   = query.data;
  const msgId  = query.message.message_id;

  await bot.answerCallbackQuery(query.id);

  // ── Voltar ao menu ──────────────────────────────────────────
  if (data === 'menu_back') {
    return bot.editMessageText('🏠 Menu Principal:', {
      chat_id: chatId, message_id: msgId,
      parse_mode: 'Markdown', reply_markup: mainMenu(),
    });
  }

  // ── PERFIL ──────────────────────────────────────────────────
  if (data === 'menu_profile') {
    const user = await getUser(userId);
    if (!user) return;
    const text =
      `👤 *Meu Perfil*\n\n` +
      `🆔 Telegram ID: \`${userId}\`\n` +
      `💶 Saldo EUR: €${parseFloat(user.balance).toFixed(2)}\n` +
      `💎 Saldo TON: ${parseFloat(user.ton_balance).toFixed(4)} TON\n` +
      `👥 Referências: ${user.referral_count}\n\n` +
      `_Podes sacar TON com 25+ referências_`;
    return bot.editMessageText(text, {
      chat_id: chatId, message_id: msgId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💎 Sacar TON', callback_data: 'withdraw_ton' }],
          [{ text: '⬅️ Voltar', callback_data: 'menu_back' }],
        ],
      },
    });
  }

  // ── REFERÊNCIAS ─────────────────────────────────────────────
  if (data === 'menu_referral') {
    const user = await getUser(userId);
    const link = `https://t.me/${(await bot.getMe()).username}?start=${userId}`;
    const text =
      `👥 *Sistema de Referências*\n\n` +
      `💎 Ganhas *0.01 TON* por cada novo utilizador que se registar com o teu link.\n\n` +
      `🔗 O teu link:\n\`${link}\`\n\n` +
      `📊 Total de referências: *${user?.referral_count || 0}*\n` +
      `💰 Saldo TON acumulado: *${parseFloat(user?.ton_balance || 0).toFixed(4)} TON*\n\n` +
      `_Mínimo para sacar: 25 referências_`;
    return bot.editMessageText(text, {
      chat_id: chatId, message_id: msgId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💎 Sacar TON', callback_data: 'withdraw_ton' }],
          [{ text: '⬅️ Voltar', callback_data: 'menu_back' }],
        ],
      },
    });
  }

  // ── SACAR TON ───────────────────────────────────────────────
  if (data === 'withdraw_ton') {
    const user = await getUser(userId);
    if (!user || user.referral_count < 25) {
      return bot.editMessageText(
        `❌ Precisas de pelo menos *25 referências* para sacar.\n\nActualmente tens *${user?.referral_count || 0}* referências.`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: backBtn('menu_referral') }
      );
    }
    const tonAmt = parseFloat(user.ton_balance);
    if (tonAmt < 0.01) {
      return bot.editMessageText(`❌ Saldo TON insuficiente (${tonAmt.toFixed(4)} TON).`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: backBtn('menu_profile') });
    }
    // Efetua transferência xRocket
    const ok = await transferToUser(userId, tonAmt, 'Saque de referências TaskMarket');
    if (!ok) {
      return bot.editMessageText(`❌ Erro ao processar transferência. Tenta novamente mais tarde.`,
        { chat_id: chatId, message_id: msgId, reply_markup: backBtn('menu_profile') });
    }
    await supabase.from('users').update({ ton_balance: 0 }).eq('telegram_id', String(userId));
    await supabase.from('transactions').insert({
      user_id: user.id, type: 'ton_withdrawal', amount: tonAmt, note: 'Saque via xRocket',
    });
    return bot.editMessageText(
      `✅ *${tonAmt.toFixed(4)} TON* enviados para a tua carteira via xRocket!`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: backBtn('menu_profile') }
    );
  }

  // ── DEPOSITAR ───────────────────────────────────────────────
  if (data === 'menu_deposit') {
    return bot.editMessageText(
      `💰 *Depositar Fundos*\n\nEscolhe o valor a depositar em TON.\nTaxa de conversão: *1 TON = €${TON_TO_EUR}*`,
      {
        chat_id: chatId, message_id: msgId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '0.5 TON (~€' + (0.5*TON_TO_EUR).toFixed(2) + ')', callback_data: 'deposit_0.5' },
             { text: '1 TON (~€'   + (1*TON_TO_EUR).toFixed(2)   + ')', callback_data: 'deposit_1'   }],
            [{ text: '2 TON (~€'   + (2*TON_TO_EUR).toFixed(2)   + ')', callback_data: 'deposit_2'   },
             { text: '5 TON (~€'   + (5*TON_TO_EUR).toFixed(2)   + ')', callback_data: 'deposit_5'   }],
            [{ text: '10 TON (~€'  + (10*TON_TO_EUR).toFixed(2)  + ')', callback_data: 'deposit_10'  }],
            [{ text: '⬅️ Voltar', callback_data: 'menu_back' }],
          ],
        },
      }
    );
  }

  // ── PROCESSAR DEPÓSITO ──────────────────────────────────────
  if (data.startsWith('deposit_')) {
    const amtTon = parseFloat(data.split('_')[1]);
    const user   = await getUser(userId);
    if (!user) return;

    let invoice;
    try {
      invoice = await createInvoice(
        amtTon,
        `Depósito TaskMarket — ${amtTon} TON`,
        `deposit_${user.id}`
      );
    } catch (e) {
      return bot.editMessageText(`❌ Erro ao gerar invoice: ${e.message}`,
        { chat_id: chatId, message_id: msgId, reply_markup: backBtn('menu_deposit') });
    }

    // Guarda invoice na BD
    await supabase.from('deposit_invoices').insert({
      user_id:    user.id,
      invoice_id: invoice.invoice_id,
      amount_ton: amtTon,
      status:     'pending',
    });

    await bot.editMessageText(
      `🧾 *Invoice gerada!*\n\n` +
      `💎 Valor: *${amtTon} TON* (~€${(amtTon*TON_TO_EUR).toFixed(2)})\n` +
      `🆔 Invoice ID: \`${invoice.invoice_id}\`\n\n` +
      `Clica no botão abaixo para pagar via xRocket.\nO saldo é creditado automaticamente após pagamento.`,
      {
        chat_id: chatId, message_id: msgId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '💳 Pagar com xRocket', url: invoice.pay_url }],
            [{ text: '🔄 Verificar Pagamento', callback_data: `check_${invoice.invoice_id}` }],
            [{ text: '⬅️ Voltar', callback_data: 'menu_back' }],
          ],
        },
      }
    );
    return;
  }

  // ── VERIFICAR PAGAMENTO ─────────────────────────────────────
  if (data.startsWith('check_')) {
    const invoiceId = data.replace('check_', '');
    const status    = await getInvoiceStatus(invoiceId);

    if (status === 'paid') {
      // Busca invoice na BD
      const { data: inv } = await supabase
        .from('deposit_invoices')
        .select('*, users(*)')
        .eq('invoice_id', invoiceId)
        .single();

      if (inv && inv.status !== 'paid') {
        const eurAmt = (parseFloat(inv.amount_ton) * TON_TO_EUR).toFixed(4);
        // Marca como pago
        await supabase.from('deposit_invoices').update({ status: 'paid', paid_at: new Date() }).eq('invoice_id', invoiceId);
        // Credita saldo EUR
        const { data: u } = await supabase.from('users').select('balance').eq('id', inv.user_id).single();
        await supabase.from('users').update({ balance: (parseFloat(u.balance) + parseFloat(eurAmt)).toFixed(4) }).eq('id', inv.user_id);
        // Transação
        await supabase.from('transactions').insert({ user_id: inv.user_id, type: 'deposit', amount: eurAmt, note: `Depósito ${inv.amount_ton} TON` });
      }

      return bot.editMessageText(
        `✅ *Pagamento confirmado!*\n\n💶 Saldo creditado com sucesso.`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: backBtn() }
      );
    }

    if (status === 'expired') {
      await supabase.from('deposit_invoices').update({ status: 'expired' }).eq('invoice_id', invoiceId);
      return bot.editMessageText(`⏰ Invoice expirada. Cria um novo depósito.`,
        { chat_id: chatId, message_id: msgId, reply_markup: backBtn('menu_deposit') });
    }

    return bot.editMessageText(
      `⏳ Pagamento ainda pendente.\n\nAguarda alguns segundos e verifica novamente.`,
      {
        chat_id: chatId, message_id: msgId,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Verificar Novamente', callback_data: `check_${invoiceId}` }],
            [{ text: '⬅️ Voltar', callback_data: 'menu_back' }],
          ],
        },
      }
    );
  }

  // ── VER TAREFAS ─────────────────────────────────────────────
  if (data === 'menu_tasks') {
    const { data: tasks } = await supabase
      .from('tasks')
      .select('*')
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(10);

    if (!tasks || tasks.length === 0) {
      return bot.editMessageText(`📋 Não há tarefas disponíveis de momento.`,
        { chat_id: chatId, message_id: msgId, reply_markup: backBtn() });
    }

    const buttons = tasks.map(t => ([{
      text: `#${t.id} ${t.title} — €${parseFloat(t.reward).toFixed(2)}`,
      callback_data: `task_view_${t.id}`,
    }]));
    buttons.push([{ text: '⬅️ Voltar', callback_data: 'menu_back' }]);

    return bot.editMessageText(
      `📋 *Tarefas disponíveis* (${tasks.length}):\n_Clica numa tarefa para ver detalhes_`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
    );
  }

  // ── VER DETALHE DE TAREFA ───────────────────────────────────
  if (data.startsWith('task_view_')) {
    const taskId = parseInt(data.split('_')[2]);
    const { data: task } = await supabase.from('tasks').select('*, users!advertiser_id(username)').eq('id', taskId).single();
    if (!task) return;

    const user = await getUser(userId);
    const isOwner    = user && task.advertiser_id === user.id;
    const isExecutor = user && task.executor_id   === user.id;

    const text =
      `📌 *Tarefa #${task.id}*\n\n` +
      `📝 ${task.title}\n` +
      `${task.description ? `📄 ${task.description}\n` : ''}` +
      `💶 Recompensa: *€${parseFloat(task.reward).toFixed(2)}*\n` +
      `⏰ Prazo: ${task.deadline || 'Sem prazo'}\n` +
      `📊 Estado: *${statusLabel(task.status)}*`;

    const buttons = [];

    if (task.status === 'open' && !isOwner) {
      buttons.push([{ text: '✅ Aceitar Tarefa', callback_data: `task_accept_${taskId}` }]);
    }
    if (task.status === 'in_progress' && isExecutor) {
      buttons.push([{ text: '📤 Submeter Conclusão', callback_data: `task_done_${taskId}` }]);
    }
    if (task.status === 'pending_review' && isOwner) {
      buttons.push([
        { text: '✅ Aprovar', callback_data: `task_approve_${taskId}` },
        { text: '❌ Rejeitar', callback_data: `task_reject_${taskId}` },
      ]);
    }
    if (isOwner && ['open'].includes(task.status)) {
      buttons.push([{ text: '🗑️ Cancelar Tarefa', callback_data: `task_cancel_${taskId}` }]);
    }

    buttons.push([{ text: '⬅️ Voltar', callback_data: 'menu_tasks' }]);

    return bot.editMessageText(text, {
      chat_id: chatId, message_id: msgId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons },
    });
  }

  // ── ACEITAR TAREFA ──────────────────────────────────────────
  if (data.startsWith('task_accept_')) {
    const taskId = parseInt(data.split('_')[2]);
    const user   = await getUser(userId);
    if (!user) return;

    const { data: task } = await supabase.from('tasks').select('*').eq('id', taskId).single();
    if (!task || task.status !== 'open') {
      return bot.editMessageText(`❌ Esta tarefa já não está disponível.`,
        { chat_id: chatId, message_id: msgId, reply_markup: backBtn('menu_tasks') });
    }
    if (task.advertiser_id === user.id) {
      return bot.editMessageText(`❌ Não podes aceitar a tua própria tarefa.`,
        { chat_id: chatId, message_id: msgId, reply_markup: backBtn('menu_tasks') });
    }

    await supabase.from('tasks').update({ status: 'in_progress', executor_id: user.id }).eq('id', taskId);

    // Notifica anunciante
    const { data: advertiser } = await supabase.from('users').select('telegram_id').eq('id', task.advertiser_id).single();
    if (advertiser) {
      bot.sendMessage(advertiser.telegram_id,
        `🔔 A tua tarefa *#${taskId} "${task.title}"* foi aceite por @${query.from.username || userId}!`,
        { parse_mode: 'Markdown' }
      ).catch(() => null);
    }

    return bot.editMessageText(
      `✅ *Tarefa aceite!*\n\nTarefa: *${task.title}*\nRecompensa: €${parseFloat(task.reward).toFixed(2)}\n\nQuando concluíres, volta aqui para submeter.`,
      {
        chat_id: chatId, message_id: msgId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📤 Submeter Conclusão', callback_data: `task_done_${taskId}` }],
            [{ text: '⬅️ Menu', callback_data: 'menu_back' }],
          ],
        },
      }
    );
  }

  // ── SUBMETER CONCLUSÃO ──────────────────────────────────────
  if (data.startsWith('task_done_')) {
    const taskId = parseInt(data.split('_')[2]);
    const user   = await getUser(userId);
    const { data: task } = await supabase.from('tasks').select('*').eq('id', taskId).single();

    if (!task || task.executor_id !== user?.id || task.status !== 'in_progress') {
      return bot.editMessageText(`❌ Operação inválida.`,
        { chat_id: chatId, message_id: msgId, reply_markup: backBtn('menu_tasks') });
    }

    await supabase.from('tasks').update({ status: 'pending_review' }).eq('id', taskId);

    // Notifica anunciante
    const { data: advertiser } = await supabase.from('users').select('telegram_id').eq('id', task.advertiser_id).single();
    if (advertiser) {
      bot.sendMessage(advertiser.telegram_id,
        `📩 A tarefa *#${taskId} "${task.title}"* foi submetida para revisão!\n\nUsa os botões abaixo para aprovar ou rejeitar:`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Aprovar', callback_data: `task_approve_${taskId}` },
              { text: '❌ Rejeitar', callback_data: `task_reject_${taskId}` },
            ]],
          },
        }
      ).catch(() => null);
    }

    return bot.editMessageText(
      `📤 *Conclusão submetida!*\n\nAguarda a aprovação do anunciante para receber o pagamento.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: backBtn() }
    );
  }

  // ── APROVAR TAREFA ──────────────────────────────────────────
  if (data.startsWith('task_approve_')) {
    const taskId = parseInt(data.split('_')[2]);
    const user   = await getUser(userId);
    const { data: task } = await supabase.from('tasks').select('*').eq('id', taskId).single();

    if (!task || task.advertiser_id !== user?.id || task.status !== 'pending_review') {
      return bot.editMessageText(`❌ Operação inválida.`,
        { chat_id: chatId, message_id: msgId, reply_markup: backBtn() });
    }

    // Chama RPC pay_executor
    const { error } = await supabase.rpc('pay_executor', { task_id: taskId });
    if (error) {
      return bot.editMessageText(`❌ Erro ao pagar executor: ${error.message}`,
        { chat_id: chatId, message_id: msgId, reply_markup: backBtn() });
    }

    await supabase.from('tasks').update({ status: 'completed' }).eq('id', taskId);

    // Notifica executor
    const { data: executor } = await supabase.from('users').select('telegram_id').eq('id', task.executor_id).single();
    if (executor) {
      bot.sendMessage(executor.telegram_id,
        `🎉 *Parabéns!* A tua tarefa *#${taskId} "${task.title}"* foi aprovada!\n\n💶 *€${parseFloat(task.reward).toFixed(2)}* creditados no teu saldo.`,
        { parse_mode: 'Markdown' }
      ).catch(() => null);
    }

    return bot.editMessageText(
      `✅ *Tarefa aprovada!*\n\n💶 €${parseFloat(task.reward).toFixed(2)} pagos ao executor.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: backBtn() }
    );
  }

  // ── REJEITAR TAREFA ─────────────────────────────────────────
  if (data.startsWith('task_reject_')) {
    const taskId = parseInt(data.split('_')[2]);
    const user   = await getUser(userId);
    const { data: task } = await supabase.from('tasks').select('*').eq('id', taskId).single();

    if (!task || task.advertiser_id !== user?.id || task.status !== 'pending_review') {
      return bot.editMessageText(`❌ Operação inválida.`,
        { chat_id: chatId, message_id: msgId, reply_markup: backBtn() });
    }

    await supabase.from('tasks').update({ status: 'in_progress' }).eq('id', taskId);

    // Notifica executor
    const { data: executor } = await supabase.from('users').select('telegram_id').eq('id', task.executor_id).single();
    if (executor) {
      bot.sendMessage(executor.telegram_id,
        `⚠️ A tua submissão para a tarefa *#${taskId} "${task.title}"* foi *rejeitada*.\n\nCorrige e resubmete.`,
        { parse_mode: 'Markdown' }
      ).catch(() => null);
    }

    return bot.editMessageText(
      `❌ Submissão rejeitada. O executor foi notificado para corrigir.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: backBtn() }
    );
  }

  // ── CANCELAR TAREFA ─────────────────────────────────────────
  if (data.startsWith('task_cancel_')) {
    const taskId = parseInt(data.split('_')[2]);
    const user   = await getUser(userId);
    const { data: task } = await supabase.from('tasks').select('*').eq('id', taskId).single();

    if (!task || task.advertiser_id !== user?.id) {
      return bot.editMessageText(`❌ Sem permissão.`,
        { chat_id: chatId, message_id: msgId, reply_markup: backBtn() });
    }

    // Devolve escrow
    const { data: u } = await supabase.from('users').select('balance').eq('id', user.id).single();
    await supabase.from('users').update({ balance: (parseFloat(u.balance) + parseFloat(task.reward)).toFixed(4) }).eq('id', user.id);
    await supabase.from('tasks').update({ status: 'cancelled' }).eq('id', taskId);
    await supabase.from('transactions').insert({ user_id: user.id, type: 'receipt', amount: task.reward, task_id: taskId, note: 'Devolução por cancelamento' });

    return bot.editMessageText(
      `🗑️ Tarefa *#${taskId}* cancelada.\n\n💶 €${parseFloat(task.reward).toFixed(2)} devolvidos ao teu saldo.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: backBtn() }
    );
  }

  // ── CRIAR TAREFA (início do wizard) ─────────────────────────
  if (data === 'menu_create') {
    const user = await getUser(userId);
    if (!user) return;
    if (parseFloat(user.balance) <= 0) {
      return bot.editMessageText(
        `❌ Saldo insuficiente para criar tarefas.\n\nDeposita fundos primeiro.`,
        {
          chat_id: chatId, message_id: msgId,
          reply_markup: {
            inline_keyboard: [
              [{ text: '💰 Depositar', callback_data: 'menu_deposit' }],
              [{ text: '⬅️ Voltar', callback_data: 'menu_back' }],
            ],
          },
        }
      );
    }

    wizards[chatId] = { step: 'title', data: {} };
    return bot.editMessageText(
      `➕ *Criar Tarefa* — Passo 1/4\n\n📝 Escreve o *título* da tarefa:`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: backBtn() }
    );
  }
});

// ════════════════════════════════════════════════════════════════
//  WIZARD DE CRIAÇÃO DE TAREFA (mensagens de texto)
// ════════════════════════════════════════════════════════════════
bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return; // ignora comandos

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text   = msg.text?.trim();
  const wizard = wizards[chatId];

  if (!wizard || !text) return;

  if (wizard.step === 'title') {
    wizard.data.title = text;
    wizard.step = 'description';
    return bot.sendMessage(chatId,
      `➕ *Criar Tarefa* — Passo 2/4\n\n📄 Escreve a *descrição* (ou envia "-" para ignorar):`,
      { parse_mode: 'Markdown' }
    );
  }

  if (wizard.step === 'description') {
    wizard.data.description = text === '-' ? null : text;
    wizard.step = 'reward';
    return bot.sendMessage(chatId,
      `➕ *Criar Tarefa* — Passo 3/4\n\n💶 Qual a *recompensa* em EUR? (ex: 5.00)`,
      { parse_mode: 'Markdown' }
    );
  }

  if (wizard.step === 'reward') {
    const reward = parseFloat(text.replace(',', '.'));
    if (isNaN(reward) || reward <= 0) {
      return bot.sendMessage(chatId, `❌ Valor inválido. Escreve um número positivo (ex: 5.00)`);
    }
    const user = await getUser(userId);
    if (!user || parseFloat(user.balance) < reward) {
      return bot.sendMessage(chatId,
        `❌ Saldo insuficiente! O teu saldo é €${parseFloat(user?.balance || 0).toFixed(2)} e a recompensa é €${reward.toFixed(2)}.`
      );
    }
    wizard.data.reward = reward;
    wizard.step = 'deadline';
    return bot.sendMessage(chatId,
      `➕ *Criar Tarefa* — Passo 4/4\n\n⏰ Qual o *prazo*? (ex: "24h", "3 dias", "-" para sem prazo)`,
      { parse_mode: 'Markdown' }
    );
  }

  if (wizard.step === 'deadline') {
    wizard.data.deadline = text === '-' ? null : text;
    delete wizards[chatId];

    const user = await getUser(userId);
    if (!user) return;

    // Deduz escrow
    const newBal = (parseFloat(user.balance) - wizard.data.reward).toFixed(4);
    await supabase.from('users').update({ balance: newBal }).eq('id', user.id);

    // Cria tarefa
    const { data: task } = await supabase.from('tasks').insert({
      advertiser_id: user.id,
      title:         wizard.data.title,
      description:   wizard.data.description,
      reward:        wizard.data.reward,
      deadline:      wizard.data.deadline,
      status:        'open',
    }).select().single();

    await supabase.from('transactions').insert({
      user_id: user.id, type: 'payment', amount: wizard.data.reward, task_id: task.id, note: 'Escrow para tarefa',
    });

    return bot.sendMessage(chatId,
      `🎉 *Tarefa criada com sucesso!*\n\n` +
      `🆔 ID: *#${task.id}*\n` +
      `📝 Título: ${task.title}\n` +
      `💶 Recompensa: €${parseFloat(task.reward).toFixed(2)} (em escrow)\n` +
      `⏰ Prazo: ${task.deadline || 'Sem prazo'}`,
      { parse_mode: 'Markdown', reply_markup: mainMenu() }
    );
  }
});

// ════════════════════════════════════════════════════════════════
//  AUTO-POLLING DE INVOICES PENDENTES (a cada 30s)
// ════════════════════════════════════════════════════════════════
setInterval(async () => {
  const { data: pending } = await supabase
    .from('deposit_invoices')
    .select('*, users(telegram_id, balance)')
    .eq('status', 'pending');

  if (!pending) return;

  for (const inv of pending) {
    const status = await getInvoiceStatus(inv.invoice_id).catch(() => null);
    if (!status) continue;

    if (status === 'paid') {
      const eurAmt = (parseFloat(inv.amount_ton) * TON_TO_EUR).toFixed(4);
      await supabase.from('deposit_invoices').update({ status: 'paid', paid_at: new Date() }).eq('invoice_id', inv.invoice_id);
      const newBal = (parseFloat(inv.users.balance) + parseFloat(eurAmt)).toFixed(4);
      await supabase.from('users').update({ balance: newBal }).eq('telegram_id', inv.users.telegram_id);
      await supabase.from('transactions').insert({ user_id: inv.user_id, type: 'deposit', amount: eurAmt, note: `Depósito ${inv.amount_ton} TON via xRocket` });

      bot.sendMessage(inv.users.telegram_id,
        `✅ *Depósito confirmado!*\n\n💶 €${eurAmt} adicionados ao teu saldo.\n_${inv.amount_ton} TON recebidos via xRocket_`,
        { parse_mode: 'Markdown', reply_markup: mainMenu() }
      ).catch(() => null);
    }

    if (status === 'expired') {
      await supabase.from('deposit_invoices').update({ status: 'expired' }).eq('invoice_id', inv.invoice_id);
      bot.sendMessage(inv.users.telegram_id,
        `⏰ Uma invoice de *${inv.amount_ton} TON* expirou. Cria um novo depósito se necessário.`,
        { parse_mode: 'Markdown' }
      ).catch(() => null);
    }
  }
}, 30_000);

// ════════════════════════════════════════════════════════════════
//  HELPERS EXTRA
// ════════════════════════════════════════════════════════════════
function statusLabel(s) {
  return { open: '🟢 Aberta', in_progress: '🔵 Em Progresso', pending_review: '🟡 A Rever', completed: '✅ Concluída', cancelled: '❌ Cancelada' }[s] || s;
}

// ── Graceful shutdown ────────────────────────────────────────────
process.on('SIGINT',  () => { bot.stopPolling(); process.exit(); });
process.on('SIGTERM', () => { bot.stopPolling(); process.exit(); });

console.log('🤖 TaskMarket Bot iniciado com xRocket Payments!');

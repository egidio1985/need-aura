process.env.NODE_ENV = "test";

const { sendTestNotificationMail } = await import("./server.mjs");

try {
  const result = await sendTestNotificationMail();
  console.log(`Mail di test inviata a ${result.recipients.join(", ")}`);
} catch (error) {
  console.error(`Mail di test non inviata: ${error.message}`);
  process.exitCode = 1;
}

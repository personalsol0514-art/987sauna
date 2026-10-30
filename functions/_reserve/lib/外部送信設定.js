function externalDeliveryEnabled() {
  return process.env.OUTBOUND_DELIVERY_ENABLED === "true";
}

module.exports = { externalDeliveryEnabled };

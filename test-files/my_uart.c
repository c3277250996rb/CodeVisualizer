#include "my_uart.h"
#include "cms8s6990.h"

#define MY_UART_RX_QUEUE_CAPACITY 8U

static volatile unsigned char xdata rx_queue[MY_UART_RX_QUEUE_CAPACITY];
static volatile unsigned char rx_queue_head;
static volatile unsigned char rx_queue_tail;

void MyUart_Init(void) {
	rx_queue_head = 0U;
	rx_queue_tail = 0U;
	SCON0 = 0x40U;
	PCON |= 0x80U;
	FUNCCR = (unsigned char)((FUNCCR & (unsigned char)~0x05U) | 0x05U);
	BRTCON = 0x00U;
	BRTDL = (unsigned char)MY_UART_BRT_RELOAD;
	BRTDH = (unsigned char)(MY_UART_BRT_RELOAD >> 8);
	BRTCON = 0x80U;
	P05CFG = 0x08U;
	RI0 = 0U;
	TI0 = 0U;
	#if MY_UART_RX_ENABLED
	P36CFG = 0x09U;
	U0REN = 1U;
	ES0 = 1U;
	#else
	U0REN = 0U;
	ES0 = 0U;
	#endif
	EA = 1U;
}

void MyUart_WriteByte(unsigned char value) {
	unsigned char uart_interrupt_enabled;

	uart_interrupt_enabled = ES0;
	ES0 = 0U;
	TI0 = 0U;
	SBUF0 = value;
	while (TI0 == 0U) {
	}
	TI0 = 0U;
	if (uart_interrupt_enabled != 0U) {
		ES0 = 1U;
	}
}

void MyUart_ReceiveByteFromISR(unsigned char value) {
	unsigned char next_tail;

	next_tail = (unsigned char)((rx_queue_tail + 1U) % MY_UART_RX_QUEUE_CAPACITY);
	if (next_tail != rx_queue_head) {
		rx_queue[rx_queue_tail] = value;
		rx_queue_tail = next_tail;
	}
}

unsigned char MyUart_ReadByte(unsigned char *value) {
	if (value == 0 || rx_queue_head == rx_queue_tail) {
		return 0U;
	}
	*value = rx_queue[rx_queue_head];
	rx_queue_head = (unsigned char)((rx_queue_head + 1U) % MY_UART_RX_QUEUE_CAPACITY);
	return 1U;
}

void MyUart_WriteString(const char *text) {
	if (text == 0) {
		return;
	}
	while (*text != '\0') {
		MyUart_WriteByte((unsigned char)*text);
		text++;
	}
}

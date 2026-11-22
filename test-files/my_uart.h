#ifndef MY_UART_H
#define MY_UART_H

#define MY_UART_TX_PIN_P05 1
#define MY_UART_RX_ENABLED 1
#define MY_UART_BAUD_RATE 115200UL
#define MY_UART_CLOCK_HZ 24000000UL
#define MY_UART_BRT_RELOAD 65523U

/* Set MY_UART_RX_ENABLED to 1 to configure P36/RXD0 and enable UART0 RX interrupts. */
/* P05CFG=0x08 selects TXD0; UART0 is 8-N-1, BRT clocked. */
/* SMOD=1 and BRT reload 0xFFF3 give about 115385 bps at 24 MHz (+0.16%). */
/* Foreground writes block until TX completes; RX is disabled by default. */
void MyUart_Init(void);
void MyUart_WriteByte(unsigned char value);
void MyUart_WriteString(const char *text);
void MyUart_ReceiveByteFromISR(unsigned char value);
unsigned char MyUart_ReadByte(unsigned char *value);

#endif
#include "cms8s6990.h"
#include "my_timer.h"
#include "my_uart.h"

void UART0_IRQHandler(void) interrupt UART0_VECTOR {
	#if MY_UART_RX_ENABLED
	unsigned char received_byte;
	if (RI0 != 0U) {
		received_byte = SBUF0;
		RI0 = 0U;
		MyUart_ReceiveByteFromISR(received_byte);
		TI0 = 0U;
		SBUF0 = received_byte;
		while (TI0 == 0U) {
		}
		TI0 = 0U;
	}
	if (TI0 != 0U) {
		TI0 = 0U;
	}
	#endif
}

void Timer3_IRQHandler(void) interrupt TMR3_VECTOR {
	MyTimer_TickISR();
}

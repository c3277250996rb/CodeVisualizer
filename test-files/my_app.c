#include "my_app.h"
#include "my_adc.h"
#include "my_motor.h"
#include "my_timer.h"
#include "my_uart.h"

static void Business_HandleInputEvent(unsigned char event, unsigned int value);

void App_Init(void) {
	MyTimer_Init();
	MyUart_Init();
	MyAdc_Init();
	MyMotor_Init();
}

void App_Task(void) {
	unsigned char received_byte;

	while (MyUart_ReadByte(&received_byte)) {
		Business_HandleInputEvent(APP_EVENT_UART_RX_BYTE, (unsigned int)received_byte);
	}

	MyMotor_Task();

	if (MyAdc_Task() == MY_ADC_EVENT_SC_READY) {
		Business_HandleInputEvent(APP_EVENT_SC_SAMPLE, MY_ADC_SC_RAW());
	}
}

static unsigned char Business_DecodeDutyCommand(unsigned char command, unsigned char *duty_percent) {
	if (duty_percent == 0U || command < (unsigned char)'0' || command > (unsigned char)'9') {
		return 0U;
	}
	*duty_percent = (unsigned char)((command - (unsigned char)'0') * 10U);
	return 1U;
}

static void Business_HandleInputEvent(unsigned char event, unsigned int value) {
	unsigned char duty_percent;

	switch (event) {
		case APP_EVENT_UART_RX_BYTE:
			if (Business_DecodeDutyCommand((unsigned char)value, &duty_percent) == 1U) {
				MyMotor_RequestDutyPercent(duty_percent);
			}
			break;

		case APP_EVENT_SC_SAMPLE:
			MyMotor_UpdateCurrentSample(value);
			break;

		default:
			break;
	}
}
